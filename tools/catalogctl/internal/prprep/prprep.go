// Package prprep is the `pr-prepare` subcommand: it turns an APPROVED
// ccp.request/v1 into the artifact bundle a bot PR carries — the catalogctl-edited
// Terraform file(s), the request itself under requests/, a plan-digest placeholder CI
// fills in, a PR body that embeds the signed approval record, and the redacted
// edit diff as evidence. It is deterministic and fully offline: no GitHub calls. The
// real `gh pr create` is a documented seam printed to stdout, not executed here.
//
// It orchestrates the existing `edit` pipeline (via cli.Edit) against a COPY of the
// env tree, so the caller's working tree is never mutated; the edited bytes are
// harvested from the copy into the output bundle.
package prprep

import (
	"bytes"
	"crypto/sha256"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// init installs cli.PRPrepare so cli.Run stays the single entrypoint (mirrors the
// edit/plancheck seams). cli imports nothing here, so no import cycle.
func init() { cli.PRPrepare = run }

// run is the `pr-prepare` subcommand. Exit codes follow spec: 0 ok · 2 refusal
// (unapproved request, split-brain quorum, target mismatch, empty diff, or a refusal
// bubbled up from `edit`) · 3 parse/schema/resolution error · 1 internal.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("pr-prepare", flag.ContinueOnError)
	fs.SetOutput(stderr)
	reqPath := fs.String("request", "", "path to the approved ccp.request/v1 YAML")
	manifestsDir := fs.String("manifests", "", "directory of ServiceManifest JSONs")
	envDir := fs.String("env", "", "directory of *.tf to edit (a COPY is edited; this tree is untouched)")
	outDir := fs.String("out", "", "output directory for the PR artifact bundle")
	envPrefix := fs.String("env-prefix", "environments/prod", "repo-relative path of the env tree (where edited files land in the bundle + diff labels)")
	estateTZ := fs.String("estate-tz", "", estatecfg.FlagUsage)
	if err := fs.Parse(args); err != nil {
		return 3
	}

	// Resolved once, before any verdict (estate-config, ADR-0028).
	cfg, err := estatecfg.Resolve(*estateTZ)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}

	if *reqPath == "" || *manifestsDir == "" || *envDir == "" || *outDir == "" {
		fmt.Fprintln(stderr, "pr-prepare: --request, --manifests, --env and --out are all required")
		return 3
	}

	reqBytes, err := os.ReadFile(*reqPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	req, err := request.Load(*reqPath, cfg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	ops, err := manifests.LoadDir(*manifestsDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	op, ok := ops[req.Item]
	if !ok {
		fmt.Fprintf(stderr, "unknown op %q\n", req.Item)
		return 3
	}

	// --- approved-request contract (before any file is touched) ---
	if len(req.Approvals) == 0 {
		return cli.Refuse(stderr, "UNAPPROVED", fmt.Sprintf("%s carries no approvals — pr-prepare only turns approved requests into PRs", req.ID))
	}
	if _, ok := req.ApprovedDigest(); !ok {
		return cli.Refuse(stderr, "DIGEST_DISAGREEMENT", fmt.Sprintf("%s approvals bind to different plan digests (split-brain quorum)", req.ID))
	}
	// Target cross-check: a stamped target must equal the op's inventory address, so a
	// mis-stamped request can never become a PR that edits a different resource.
	resolvedTarget := inventoryAddr(op, req.Params)
	if req.Target != "" && req.Target != resolvedTarget {
		return cli.Refuse(stderr, "TARGET_MISMATCH", fmt.Sprintf("request target %q != op inventory address %q", req.Target, resolvedTarget))
	}

	// --- Run `edit` against a throwaway copy of the env tree ---
	if cli.Edit == nil {
		fmt.Fprintln(stderr, "internal: edit not wired (blank-import internal/edit)")
		return 1
	}
	work, err := os.MkdirTemp("", "catalogctl-prprep-*")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer os.RemoveAll(work)
	before, err := copyTreeSnapshot(*envDir, work)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	var diff bytes.Buffer
	code := cli.Edit([]string{
		"--request", *reqPath,
		"--manifests", *manifestsDir,
		"--env", work,
		"--diff-prefix", *envPrefix,
		// Forward the exact estate-tz value THIS invocation resolved (flag, env, or
		// default) so the inner edit's own request.Load can never disagree with the
		// outer Load above — both must validate window.tz against the same estate.
		"--estate-tz", cfg.EstateTZ,
	}, &diff, stderr)
	if code != 0 {
		// A refusal (2) / resolution error (3) / internal (1) from edit is surfaced
		// verbatim: the reason is already on stderr. No PR is produced.
		fmt.Fprintf(stderr, "pr-prepare: edit did not produce a change (exit %d) — no PR artifact written\n", code)
		return code
	}

	changed, err := changedFiles(work, before)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if len(changed) == 0 {
		return cli.Refuse(stderr, "EMPTY_DIFF", fmt.Sprintf("%s edits nothing (verified no-op) — an empty change is not a PR", req.ID))
	}

	// --- Assemble the bundle ---
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	var written []string
	// (a) edited file(s), at their repo-relative env path.
	for _, rel := range changed {
		src := filepath.Join(work, rel)
		dst := filepath.Join(*outDir, filepath.FromSlash(*envPrefix), rel)
		if err := copyFile(src, dst); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		written = append(written, filepath.ToSlash(filepath.Join(*envPrefix, rel)))
	}
	// (b) the request artifact, verbatim, under requests/.
	reqOut := filepath.Join("requests", req.ID+".yaml")
	if err := writeFile(filepath.Join(*outDir, reqOut), reqBytes); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	written = append(written, filepath.ToSlash(reqOut))
	// (c) the plan-digest placeholder CI overwrites with sha256(plan.json).
	digestOut := filepath.Join("requests", req.ID+".plan-digest")
	if err := writeFile(filepath.Join(*outDir, digestOut), []byte(digestPlaceholder(req))); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	written = append(written, filepath.ToSlash(digestOut))
	// (d) the redacted edit diff, as evidence.
	diffOut := filepath.Join("requests", req.ID+".diff")
	if err := writeFile(filepath.Join(*outDir, diffOut), diff.Bytes()); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	written = append(written, filepath.ToSlash(diffOut))
	// (e) the PR body embedding the signed approval record.
	body := renderPRBody(req, resolvedTarget, written, diff.String())
	if err := writeFile(filepath.Join(*outDir, "PR_BODY.md"), []byte(body)); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	written = append(written, "PR_BODY.md")

	printManifest(stdout, req, written)
	return 0
}

// branchName / prTitle are the deterministic bot-PR identity the gh seam consumes.
func branchName(r *request.Request) string { return "ccp/" + r.ID }
func prTitle(r *request.Request) string    { return fmt.Sprintf("ccp(%s): %s", r.Item, r.ID) }

// digestPlaceholder is the initial content of requests/<id>.plan-digest. CI's plan job
// overwrites it with the real sha256(plan.json); until then it is PENDING so the
// bundle is complete and the file path is stable across the request's life.
func digestPlaceholder(r *request.Request) string {
	return strings.Join([]string{
		"# plan digest for " + r.ID,
		"# CI (terraform plan job, plan-8 W2) overwrites this with sha256(plan.json)",
		"# and posts it as the `ccp/plan-digest` commit status. Approvals in the",
		"# request bind to this exact digest (approve-this-exact-plan).",
		"status: PENDING",
		"algorithm: sha256",
		"digest: \"\"",
		"",
	}, "\n")
}

// inventoryAddr returns the op's single source:"inventory" (non-reference) param value —
// the resource address the op edits. Mirrors edit.targetAddress / plancheck.inventoryAddr;
// kept local so prprep does not reach into another package's unexported helper.
func inventoryAddr(op manifests.Op, params map[string]any) string {
	for _, p := range op.Params {
		if p.Source == "inventory" && p.Role != "reference" {
			if s, ok := params[p.Name].(string); ok {
				return s
			}
		}
	}
	return ""
}

// printManifest writes a deterministic, human- and script-readable summary plus the
// documented (not executed) gh seam.
func printManifest(w io.Writer, r *request.Request, written []string) {
	sort.Strings(written)
	fmt.Fprintf(w, "pr-prepare: %s (%s)\n", r.ID, r.Item)
	fmt.Fprintf(w, "  branch: %s\n", branchName(r))
	fmt.Fprintf(w, "  title:  %s\n", prTitle(r))
	fmt.Fprintln(w, "  files:")
	for _, f := range written {
		fmt.Fprintf(w, "    %s\n", f)
	}
	fmt.Fprintln(w, "  seam (run from the bundle dir, not executed here):")
	fmt.Fprintf(w, "    gh pr create --head %s --title %q --body-file PR_BODY.md --label ccp:approved\n", branchName(r), prTitle(r))
}

// --- file helpers ---

// copyTreeSnapshot copies src into dst (recursively) and returns a map of
// slash-relative path → sha256 of every regular file copied, the "before" baseline
// changedFiles diffs against. Skips catalogctl's atomic-write temp files.
func copyTreeSnapshot(src, dst string) (map[string][32]byte, error) {
	snap := map[string][32]byte{}
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			if rel == "." {
				return nil
			}
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		if strings.HasPrefix(d.Name(), ".catalogctl-") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		snap[filepath.ToSlash(rel)] = sha256.Sum256(b)
		return writeFile(filepath.Join(dst, rel), b)
	})
	if err != nil {
		return nil, err
	}
	return snap, nil
}

// changedFiles returns the slash-relative paths under work whose bytes differ from
// (or are absent in) the before snapshot, sorted. Edit never deletes files, so a
// disappeared path is not tracked.
func changedFiles(work string, before map[string][32]byte) ([]string, error) {
	var out []string
	err := filepath.WalkDir(work, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".catalogctl-") {
			return nil
		}
		rel, err := filepath.Rel(work, path)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if old, ok := before[key]; !ok || old != sha256.Sum256(b) {
			out = append(out, key)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return writeFile(dst, b)
}

func writeFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

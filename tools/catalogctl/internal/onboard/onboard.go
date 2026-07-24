// Package onboard is the ordered onboarding orchestrator (spec).
//
// The ORDER of the steps IS the security property: a repo is parsed and scanned
// (prescan) BEFORE any trust decision, and terraform init is invoked ONLY after
// a Lead's trust-ack matches HEAD. init therefore never runs for a rejected or
// untrusted repo. The flow:
//
//  1. record commitSha            (git rev-parse HEAD, best-effort)
//  2. prescan                     → prescan-report.json persisted on BOTH verdicts (
//     the artifact the Admin → Projects wizard uploads and the api sha-verifies);
//     on reject: print findings, refuse, exit 2 (no runner call)
//  3. trust gate                  → no --trusted-commit: write trust-request.json, stop (exit 0)
//     mismatch: refuse (exit 2). Both before any runner call.
//  4. required_version gate       → refuse if the installed terraform can't satisfy it (pre-init)
//  5. sandboxed init + schema     → runner.Init then runner.ProvidersSchema → providers-schema.json
//  6. empty-inventory guard       → refuse EMPTY_INVENTORY if prescan saw resources but 0 extracted
//  7. scaffold checklist + census (module/fmt-dirty/.tf.json/pins report)
//
// Optionally (spec docs/superpowers/specs/2026-07-24-easy-first-import.md §3
// option C; ADR-0031): when --server is set and CCP_ONBOARD_TOKEN is present
// in the environment, steps 2 and 3 additionally PUT their just-written
// artifacts to <server>/projects/<project-id>/trust-request — strictly AFTER
// the files are already safely on disk, on both verdicts, so a Lead's review
// always has something to see. This is pure convenience: a reachability or
// HTTP error during upload changes neither the files on disk nor Run's exit
// code — see attemptUpload in upload.go.
//
// Nothing here uses AI and onboarding grants no apply path;
// see ccp/docs/onboarding-security.md.
package onboard

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclparse"
	"github.com/zclconf/go-cty/cty"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/prescan"
)

func init() { cli.Onboard = run }

// Opts configures a single onboard run.
type Opts struct {
	Root          string   // path to the repo/root to onboard
	ProjectID     string   // target project id
	TrustedCommit string   // Lead-acked HEAD sha; empty ⇒ stop at the trust request
	OutDir        string   // where trust-request.json / prescan-report.json / providers-schema.json are written
	Allowlist     []string // provider allowlist (nil ⇒ prescan default: hashicorp only)

	// Server, when non-empty, is the control-plane base URL: once either
	// terminal path below has WRITTEN its file(s) to OutDir, Run additionally
	// PUTs them to Server/projects/ProjectID/trust-request (spec §3 option C)
	// — purely additive, never a substitute for the files on disk. Empty ⇒
	// the upload path is never entered: byte-for-byte today's behavior.
	Server string
	// OnboardToken is the bearer credential for the Server upload. ENV ONLY
	// at the CLI layer (CCP_ONBOARD_TOKEN, read in run() below) — never a
	// flag or argument, so it can't leak into a process listing or CI log
	// (the same rule scripts/gen-project-data.sh documents for
	// CCP_UPLOAD_TOKEN). Both Server and OnboardToken must be non-empty for
	// an upload to be attempted.
	OnboardToken string
}

// Runner is the sandbox seam. The real implementation shells to terraform under
// the committed sandbox contract; tests inject a recording fake.
type Runner interface {
	Init(dir string) error
	ProvidersSchema(dir string) ([]byte, error)
}

// Process-touching seams, overridable in tests.
var (
	gitHead      = realGitHead
	tfVersion    = realTFVersion
	extractAddrs = realExtractAddrs
)

// Run executes the ordered flow and returns a process exit code
// (0 ok · 2 refusal · 3 terraform/schema error · 1 internal). uploader is the
// seam for the optional --server upload (see Opts.Server); tests may pass nil
// when Opts.Server is empty, since attemptUpload never dereferences it then.
func Run(opts Opts, runner Runner, uploader Uploader, stdout io.Writer) int {
	fmt.Fprintf(stdout, "onboard: project %q from %s\n", opts.ProjectID, filepath.Base(opts.Root))

	// 1. commit sha (best-effort; a missing git still allows the trust-request stop).
	commitSha, _ := gitHead(opts.Root)

	// 2. prescan — the static gate. Runs before ANY trust decision or execution.
	rep, err := prescan.Scan(opts.Root, opts.Allowlist)
	if err != nil {
		fmt.Fprintf(stdout, "internal: prescan failed: %v\n", err)
		return 1
	}
	printCensus(stdout, rep)

	// Persist the report the Lead actually reviews: the EXACT bytes
	// the trust sha binds to, written on BOTH verdicts — a reject's findings must
	// reach the Admin → Projects wizard instead of dying on stdout, and a Lead is
	// never asked to trust a sha of bytes they cannot open.
	prescanBytes, _ := json.MarshalIndent(rep, "", "  ")
	prescanBytes = append(prescanBytes, '\n')
	sum := sha256.Sum256(prescanBytes)
	prescanSha := hex.EncodeToString(sum[:])
	if err := writeBytes(opts.OutDir, "prescan-report.json", prescanBytes); err != nil {
		fmt.Fprintf(stdout, "internal: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "prescan-report.json written (verdict %s, sha256 %s)\n", rep.Verdict, short(prescanSha))

	if rep.Verdict == "reject" {
		fmt.Fprintf(stdout, "prescan: REJECT — %d finding(s):\n", len(rep.Findings))
		for _, f := range rep.Findings {
			fmt.Fprintf(stdout, "  %s %s:%d\n", f.Code, f.File, f.Line)
		}
		fmt.Fprintln(stdout, "  findings persisted in prescan-report.json for review in Admin → Projects; a rejected repo can never be trusted")
		// Upload strictly AFTER prescan-report.json is already persisted above
		// (line ~95) — a reject verdict's findings must reach the wizard too.
		attemptUpload(stdout, opts, uploader, TrustRequestTriple{Repo: rep.Repo, CommitSha: commitSha, PrescanSha256: prescanSha}, prescanBytes)
		return refuse(stdout, "PRESCAN_REJECT",
			fmt.Sprintf("%d finding(s); nothing executed (no terraform init)", len(rep.Findings)))
	}
	fmt.Fprintln(stdout, "prescan: clean — 0 findings")

	// 3. trust gate. prescanSha256 binds the trust-ack to the exact scanned bytes.
	if opts.TrustedCommit == "" {
		tr := map[string]string{"repo": rep.Repo, "commitSha": commitSha, "prescanSha256": prescanSha}
		if err := writeJSON(opts.OutDir, "trust-request.json", tr); err != nil {
			fmt.Fprintf(stdout, "internal: %v\n", err)
			return 1
		}
		fmt.Fprintf(stdout, "trust required: wrote trust-request.json + prescan-report.json (commitSha %s, prescanSha256 %s)\n",
			short(commitSha), short(prescanSha))
		// Upload strictly AFTER both files are already persisted above (this
		// write + the prescan-report.json write at line ~95).
		uploaded := attemptUpload(stdout, opts, uploader, TrustRequestTriple{Repo: rep.Repo, CommitSha: commitSha, PrescanSha256: prescanSha}, prescanBytes)
		if !uploaded {
			fmt.Fprintln(stdout, "  next: in Admin → Projects, upload trust-request.json + prescan-report.json (wizard step ②),")
		}
		fmt.Fprintf(stdout, "  have a Lead review the verdict and trust this commit, then re-run with --trusted-commit %s\n", commitSha)
		return 0
	}
	if opts.TrustedCommit != commitSha {
		return refuse(stdout, "UNTRUSTED_COMMIT",
			fmt.Sprintf("--trusted-commit %s does not match HEAD %s; re-ack required", short(opts.TrustedCommit), short(commitSha)))
	}

	// 4. required_version gate — refuse before invoking terraform.
	installed, verr := tfVersion()
	if verr != nil {
		return refuse(stdout, "TERRAFORM_MISSING", verr.Error())
	}
	constraint, _ := readRequiredVersion(opts.Root)
	if constraint != "" {
		ok, cerr := versionSatisfies(installed, constraint)
		if cerr != nil {
			return refuse(stdout, "VERSION_UNPARSEABLE", cerr.Error())
		}
		if !ok {
			return refuse(stdout, "VERSION_UNSATISFIED",
				fmt.Sprintf("installed terraform %s does not satisfy required_version %q", installed, constraint))
		}
	}

	// 5. sandboxed init + schema (trusted only). Init strictly precedes schema.
	if err := runner.Init(opts.Root); err != nil {
		fmt.Fprintf(stdout, "terraform init failed: %v\n", err)
		return 3
	}
	schema, err := runner.ProvidersSchema(opts.Root)
	if err != nil {
		fmt.Fprintf(stdout, "terraform providers schema failed: %v\n", err)
		return 3
	}
	if err := writeBytes(opts.OutDir, "providers-schema.json", schema); err != nil {
		fmt.Fprintf(stdout, "internal: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "providers-schema.json written (%d bytes)\n", len(schema))

	// 6. empty-inventory guard — refuse a silent-empty import.
	addrs, err := extractAddrs(opts.Root)
	if err != nil {
		fmt.Fprintf(stdout, "internal: resource extraction failed: %v\n", err)
		return 1
	}
	if rep.ResourceBlocks > 0 && len(addrs) == 0 {
		return refuse(stdout, "EMPTY_INVENTORY",
			fmt.Sprintf("prescan counted %d resource block(s) but extraction produced 0 — refusing a silent-empty import", rep.ResourceBlocks))
	}

	// 7. scaffold checklist.
	printScaffold(stdout, opts, rep, addrs)
	return 0
}

func printCensus(w io.Writer, rep prescan.Report) {
	fmt.Fprintf(w, "  resource blocks: %d\n", rep.ResourceBlocks)
	fmt.Fprintf(w, "  modules:         %d  (resources behind modules are NOT imported)\n", rep.ModuleBlocks)
	fmt.Fprintf(w, "  .tf.json files:  %d\n", rep.TfJsonFiles)
	fmt.Fprintf(w, "  fmt-dirty files: %d  (remediation: terraform fmt -recursive as a one-time normalization PR)\n", rep.FmtDirtyFiles)
	if len(rep.ProviderPins) > 0 {
		keys := make([]string, 0, len(rep.ProviderPins))
		for k := range rep.ProviderPins {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b strings.Builder
		for i, k := range keys {
			if i > 0 {
				b.WriteString(", ")
			}
			fmt.Fprintf(&b, "%s=%s", k, rep.ProviderPins[k])
		}
		fmt.Fprintf(w, "  provider pins:   %s\n", b.String())
	}
}

func printScaffold(w io.Writer, opts Opts, rep prescan.Report, addrs []string) {
	fmt.Fprintf(w, "extracted %d resource address(es) for project %q\n", len(addrs), opts.ProjectID)
	fmt.Fprintln(w, "next — scaffold with the existing extractors (catalogctl inventory supersedes this later):")
	fmt.Fprintf(w, "  npx vite-node scripts/extract-blocks.ts -- --root %s --out ccp/app/src/data/projects/%s/blocks\n", opts.Root, opts.ProjectID)
	fmt.Fprintf(w, "  fill project.json: id=%s, name, github, region, providerTag (record the provider pin), teams\n", opts.ProjectID)
	if rep.FmtDirtyFiles > 0 {
		fmt.Fprintf(w, "  NOTE: %d fmt-dirty file(s) — run `terraform fmt -recursive` as a one-time normalization PR;\n", rep.FmtDirtyFiles)
		fmt.Fprintln(w, "        catalogctl edit's FMT_DIRTY refusal stays in force — imported files are never auto-reformatted.")
	}
}

func refuse(w io.Writer, code, reason string) int {
	fmt.Fprintf(w, "REFUSE %s: %s\n", code, reason)
	return 2
}

func short(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

func writeBytes(dir, name string, b []byte) error {
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name), b, 0o644)
}

func writeJSON(dir, name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeBytes(dir, name, append(b, '\n'))
}

// ---- version constraint evaluation (minimal, no new dependency) ----

// versionSatisfies reports whether installed satisfies a terraform-style
// comma-joined constraint (AND). Supports >=, >, <=, <, =, ==, !=, ~>.
func versionSatisfies(installed, constraint string) (bool, error) {
	constraint = strings.TrimSpace(constraint)
	if constraint == "" {
		return true, nil
	}
	iv := parseVer(installed)
	for _, term := range strings.Split(constraint, ",") {
		term = strings.TrimSpace(term)
		if term == "" {
			continue
		}
		op, rest := "=", term
		for _, o := range []string{"~>", ">=", "<=", "==", "!=", ">", "<", "="} {
			if strings.HasPrefix(term, o) {
				op, rest = o, strings.TrimSpace(term[len(o):])
				break
			}
		}
		cv := parseVer(rest)
		c := cmpVer(iv, cv)
		var ok bool
		switch op {
		case ">=":
			ok = c >= 0
		case ">":
			ok = c > 0
		case "<=":
			ok = c <= 0
		case "<":
			ok = c < 0
		case "=", "==":
			ok = c == 0
		case "!=":
			ok = c != 0
		case "~>":
			ok = c >= 0 && cmpVer(iv, pessimisticUpper(cv)) < 0
		default:
			return false, fmt.Errorf("unsupported version operator %q", op)
		}
		if !ok {
			return false, nil
		}
	}
	return true, nil
}

func parseVer(s string) []int {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			n = 0
		}
		out = append(out, n)
	}
	return out
}

func cmpVer(a, b []int) int {
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		var av, bv int
		if i < len(a) {
			av = a[i]
		}
		if i < len(b) {
			bv = b[i]
		}
		if av != bv {
			if av < bv {
				return -1
			}
			return 1
		}
	}
	return 0
}

// pessimisticUpper is the exclusive upper bound of ~>: it increments the
// second-to-last specified segment (the last, if only one is given).
func pessimisticUpper(cv []int) []int {
	if len(cv) == 0 {
		return []int{0}
	}
	idx := len(cv) - 2
	if idx < 0 {
		idx = 0
	}
	ub := make([]int, idx+1)
	copy(ub, cv[:idx+1])
	ub[idx]++
	return ub
}

// ---- real seam implementations ----

func realGitHead(dir string) (string, error) {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "HEAD")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func realTFVersion() (string, error) {
	cmd := exec.Command("terraform", "version", "-json")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", err
	}
	var v struct {
		TerraformVersion string `json:"terraform_version"`
	}
	if err := json.Unmarshal(out.Bytes(), &v); err != nil {
		return "", err
	}
	if v.TerraformVersion == "" {
		return "", fmt.Errorf("could not determine terraform version")
	}
	return v.TerraformVersion, nil
}

// realExtractAddrs is an INDEPENDENT resource-address walk (separate from
// prescan's census) so the guard catches a divergence between the two.
func realExtractAddrs(root string) ([]string, error) {
	schema := &hcl.BodySchema{Blocks: []hcl.BlockHeaderSchema{{Type: "resource", LabelNames: []string{"type", "name"}}}}
	parser := hclparse.NewParser()
	var addrs []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".terraform" || d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		f, ok := parseTF(parser, p, d.Name())
		if !ok {
			return nil
		}
		c, _, _ := f.Body.PartialContent(schema)
		for _, b := range c.Blocks {
			if len(b.Labels) == 2 {
				addrs = append(addrs, b.Labels[0]+"."+b.Labels[1])
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(addrs)
	return addrs, nil
}

func readRequiredVersion(root string) (string, error) {
	tfSchema := &hcl.BodySchema{Blocks: []hcl.BlockHeaderSchema{{Type: "terraform"}}}
	verSchema := &hcl.BodySchema{Attributes: []hcl.AttributeSchema{{Name: "required_version"}}}
	parser := hclparse.NewParser()
	var found string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".terraform" || d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if found != "" {
			return nil
		}
		f, ok := parseTF(parser, p, d.Name())
		if !ok {
			return nil
		}
		c, _, _ := f.Body.PartialContent(tfSchema)
		for _, b := range c.Blocks {
			cc, _, _ := b.Body.PartialContent(verSchema)
			if a, ok := cc.Attributes["required_version"]; ok {
				if v, sok := staticStr(a.Expr); sok && found == "" {
					found = v
				}
			}
		}
		return nil
	})
	return found, err
}

func parseTF(parser *hclparse.Parser, path, name string) (*hcl.File, bool) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var f *hcl.File
	var diags hcl.Diagnostics
	switch {
	case strings.HasSuffix(name, ".tf.json"):
		f, diags = parser.ParseJSON(src, path)
	case strings.HasSuffix(name, ".tf"):
		f, diags = parser.ParseHCL(src, path)
	default:
		return nil, false
	}
	if diags.HasErrors() || f == nil {
		return nil, false
	}
	return f, true
}

func staticStr(expr hcl.Expression) (string, bool) {
	if len(expr.Variables()) > 0 {
		return "", false
	}
	v, diags := expr.Value(nil)
	if diags.HasErrors() || v.IsNull() || v.Type() != cty.String {
		return "", false
	}
	return v.AsString(), true
}

// ---- CLI wiring ----

// onboardTokenEnv is where run() reads the bearer credential for the optional
// --server upload — ENV ONLY, never a flag or CLI argument, so it can never
// leak into a process listing or CI step log (scripts/gen-project-data.sh
// documents the identical rule for CCP_UPLOAD_TOKEN).
const onboardTokenEnv = "CCP_ONBOARD_TOKEN"

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("onboard", flag.ContinueOnError)
	fs.SetOutput(stderr)
	projectID := fs.String("project-id", "", "target project id (required)")
	trusted := fs.String("trusted-commit", "", "Lead-acked HEAD sha; empty ⇒ stop at the trust request")
	outDir := fs.String("out", ".", "directory for trust-request.json / prescan-report.json / providers-schema.json")
	server := fs.String("server", "", "control-plane base URL; when set (with "+onboardTokenEnv+
		" in the environment), the two just-written artifacts are also PUT to <server>/projects/<project-id>/trust-request "+
		"after --out is written — purely additive, never a substitute for --out")

	// Support the documented path-first form: onboard <path> --project-id <id> ...
	var pathArg string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		pathArg, args = args[0], args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return 3
	}
	if pathArg == "" && fs.NArg() > 0 {
		pathArg = fs.Arg(0)
	}
	if pathArg == "" {
		fmt.Fprintln(stderr, "usage: catalogctl onboard <path> --project-id <id> [--trusted-commit <sha>] [--out <dir>] [--server <url>]")
		return 3
	}
	if *projectID == "" {
		fmt.Fprintln(stderr, "onboard: --project-id is required")
		return 3
	}
	opts := Opts{
		Root:          pathArg,
		ProjectID:     *projectID,
		TrustedCommit: *trusted,
		OutDir:        *outDir,
		Server:        *server,
		OnboardToken:  os.Getenv(onboardTokenEnv), // env only — never a flag (see onboardTokenEnv)
	}
	return Run(opts, execRunner{}, httpUploader{}, stdout)
}

// execRunner is the host-side realization of the sandbox contract, used for the
// self-trusted in-repo target (spec). It fails closed if
// any cloud credential is present and always runs init with -backend=false.
type execRunner struct{}

func (execRunner) Init(dir string) error {
	if err := assertNoCloudCreds(); err != nil {
		return err
	}
	cmd := exec.Command("terraform", "init", "-backend=false", "-input=false")
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	return cmd.Run()
}

func (execRunner) ProvidersSchema(dir string) ([]byte, error) {
	cmd := exec.Command("terraform", "providers", "schema", "-json")
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func assertNoCloudCreds() error {
	for _, kv := range os.Environ() {
		name := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			name = kv[:i]
		}
		for _, pfx := range []string{"AWS_", "GOOGLE_", "ARM_", "TF_TOKEN_"} {
			if strings.HasPrefix(name, pfx) {
				return fmt.Errorf("cloud/registry credential %s present in environment — refusing (sandbox contract)", name)
			}
		}
	}
	return nil
}

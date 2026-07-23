package driftpropose

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
)

// driftedit.go is the `drift-edit` subcommand (spec §7 / addendum A2-A3,
// §2-F1c): the missing edit-replay entrypoint the audit found absent —
// `drift-propose` generates a proposal against a SCRATCH checkout at snapshot
// time, but nothing had ever re-run that same edit against the checkout the
// bundle gate actually commits from. This closes that gap:
//
//	catalogctl drift-edit --request <.bundle-request.json> --repo "$BUNDLE_CHECKOUT" --root environments/prod
//
// Per adopt item, in items order: (1) digest cross-check — tamper evidence;
// (2) per pinned verdict, re-derive §6.2 eligibility (enforcement point 3,
// independent of points 1-2) and run the fourth screen (F4) against the
// CHECKOUT'S OWN watchlist; (3) apply the identical mechanical edit
// (ApplyAdopt — the same adoptEdit core GenerateAdopt used to produce the
// original proposal). Per revert/restore/legitimize item: no edit, an INFO
// line — one uniform gate script calls drift-edit unconditionally for every
// drift op (spec: "the operator gate command becomes `catalogctl drift-edit …
// && terraform plan … && catalogctl plan-check …`").
//
// Exit codes mirror drift-propose: 0 edits applied / none needed · 2 refusal
// (tamper evidence, failed eligibility, a watchlist hit, or an ungenerable
// checkout-dependent refinement — address gone, map missing, a repeated nested
// block, …) · 3 request malformed, unreadable, or not a (single, consistent)
// drift op · 4 checkout unusable · 1 internal.
func init() { cli.DriftEdit = runDriftEdit }

func runDriftEdit(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("drift-edit", flag.ContinueOnError)
	fs.SetOutput(stderr)
	reqPath := fs.String("request", "", "path to the .bundle-request.json")
	repo := fs.String("repo", "", "checkout to edit (the bundle's $BUNDLE_CHECKOUT)")
	root := fs.String("root", "", "state root inside --repo to scan for *.tf (e.g. environments/prod)")
	if err := fs.Parse(args); err != nil {
		return 3
	}
	if *reqPath == "" || *repo == "" || *root == "" {
		fmt.Fprintln(stderr, "drift-edit: --request, --repo and --root are all required")
		return 3
	}

	br, err := ParseBundleRequest(*reqPath)
	if err != nil {
		fmt.Fprintf(stderr, "drift-edit: %v\n", err)
		return 3
	}
	items := br.ItemsOrSelf()
	if len(items) == 0 {
		fmt.Fprintln(stderr, "drift-edit: bundle request carries no items")
		return 3
	}
	first := items[0].OperationID
	for _, it := range items {
		if !isDriftEditOp(it.OperationID) {
			fmt.Fprintf(stderr, "drift-edit: %q is not a gate-known drift system op\n", it.OperationID)
			return 3
		}
		if it.OperationID != first {
			fmt.Fprintln(stderr, "drift-edit: bundle request items do not all name the same drift system op")
			return 3
		}
	}

	envDir := filepath.Join(*repo, *root)
	if info, statErr := os.Stat(envDir); statErr != nil || !info.IsDir() {
		fmt.Fprintf(stderr, "drift-edit: checkout root %s is not a usable directory: %v\n", envDir, statErr)
		return 4
	}

	switch first {
	case opAdopt:
		return runDriftEditAdopt(items, *repo, envDir, stdout, stderr)
	case opRevert:
		// spec §6.4/§7: revert carries NO edit — the mechanical meaning is "an
		// apply of current HEAD, scoped to the drifted addresses," enforced by
		// R8 at plan-check time, never by an edit here.
		fmt.Fprintln(stdout, "INFO drift-edit: system-drift-revert carries no edit — nothing to replay")
		return 0
	case opImport:
		// spec 2026-07-20-ccp-oob-provisioning-import.md §7.1: unlike
		// revert, import DOES carry a write — appending the pinned
		// import{}+resource{} bytes to oob-adopted.tf.
		return runDriftEditImport(items, *repo, envDir, stdout, stderr)
	case opRestore:
		// plan 2026-07-20-drift-restore-tranche.md §2.4: restore mirrors
		// revert byte-for-spirit — NO edit. The mechanical meaning is
		// "re-assert the code already on main, scoped to the deleted
		// address(es)," enforced by R9 (restore-scoped-create) at plan-check
		// time, never by an edit here.
		fmt.Fprintln(stdout, "INFO drift-edit: system-drift-restore carries no edit — the plan re-asserts current code; R9 verifies the scoped create")
		return 0
	case opLegitimize:
		// plan 2026-07-20-drift-restore-tranche.md §4 (register 0009 L32):
		// legitimize also carries NO edit — the engineer's convergence change
		// already landed via its OWN linked PR before this request was ever
		// submitted; this request is only the closure step. The fourth screen
		// is deliberately not applied either (there is no edit to screen —
		// the scrutiny substitute is the engineer tier + full ladder + TOTP,
		// spec addendum A6). R11 (legitimize-zero-delta) verifies the plan is
		// already a clean no-op at plan-check time.
		fmt.Fprintln(stdout, "INFO drift-edit: system-drift-legitimize carries no edit — the engineer's convergence change lands via its linked PR; R11 verifies the plan is already a clean no-op")
		return 0
	default:
		// Unreachable: isDriftEditOp already gated every item above. Kept as a
		// fail-closed belt-and-braces refusal rather than a silent fallthrough.
		fmt.Fprintf(stderr, "drift-edit: %q is not a gate-known drift system op\n", first)
		return 3
	}
}

// isDriftEditOp reports whether id is one of the five ops drift-edit knows how
// to handle: adopt, revert, import (spec 2026-07-20-ccp-oob-provisioning-
// import.md §7.1), and — plan 2026-07-20-drift-restore-tranche.md §2.4/§4,
// register 0009 L29/L32 — restore and legitimize. The last two carry no edit
// at all (a pure INFO no-op, see the switch above): restore re-asserts code
// already on main, and legitimize's convergence change already landed via its
// own linked PR before submit. Any OTHER op id is refused here exactly like
// any unrecognised op (exit 3) — this switch is now the complete, closed set
// the bundle gate's drift-edit half knows.
func isDriftEditOp(id string) bool {
	return id == opAdopt || id == opRevert || id == opImport || id == opRestore || id == opLegitimize
}

// runDriftEditAdopt drives every item's adopt replay in order (spec §2-F1c).
// The checkout's watchlist is loaded ONCE (fail-closed doctrine matches
// Generate's F4 wiring: an unreadable/unparseable watchlist refuses every
// adopt item in this request, never guessed item-by-item).
func runDriftEditAdopt(items []BundleRequestItem, repo, envDir string, stdout, stderr io.Writer) int {
	watchlist, watchlistErr := LoadWatchlist(repo)

	wrote := 0
	for i, item := range items {
		var p AdoptParams
		if err := json.Unmarshal(item.Params, &p); err != nil {
			fmt.Fprintf(stderr, "drift-edit: item %d: pinned params: %v\n", i, err)
			return 3
		}
		if len(p.Attrs) == 0 {
			fmt.Fprintf(stderr, "drift-edit: item %d: pinned params carry no attrs\n", i)
			return 3
		}
		if len(p.Verdicts) == 0 {
			fmt.Fprintf(stderr, "drift-edit: item %d: pinned params carry no verdicts\n", i)
			return 3
		}

		// (1) digest cross-check — tamper evidence. Recomputed over exactly
		// what §2.4 hashes: the pinned attrs, addresses derived from them.
		gotDigest := ProposalDigest("adopt", addressesFromAttrs(p.Attrs), p.Attrs)
		if gotDigest != p.ProposalDigest {
			fmt.Fprintf(stderr, "drift-edit: item %d: digest mismatch — recomputed %s, pinned %s (tamper evidence)\n", i, gotDigest, p.ProposalDigest)
			return 2
		}

		for _, v := range p.Verdicts {
			// (2a) re-derive §6.2 eligibility — enforcement point 3, independent
			// of points 1 (drift-propose) and 2 (the api's stored-report
			// re-check): a forged or tampered pinned verdict is refused here
			// even if every earlier gate somehow let it through.
			if bucket, reason := ClassifyByFields(v); bucket != BucketAdopt {
				fmt.Fprintf(stderr, "drift-edit: item %d: %s: re-derived §6.2 eligibility failed (enforcement point 3): %s\n", i, v.Address, reason)
				return 2
			}
			// (2b) the fourth screen (F4) — the checkout's own watchlist,
			// independent of what the pinned verdict itself claims.
			if watchlistErr != nil {
				fmt.Fprintf(stderr, "drift-edit: item %d: %s: security watchlist unreadable in checkout — refusing every adopt: %v\n", i, v.Address, watchlistErr)
				return 2
			}
			if reason, hit := watchlist.ScreenVerdict(v); hit {
				fmt.Fprintf(stderr, "drift-edit: item %d: %s: %s\n", i, v.Address, reason)
				return 2
			}

			// (3) apply the identical mechanical edit.
			did, ungenReason, err := ApplyAdopt(v, envDir)
			if err != nil {
				fmt.Fprintf(stderr, "drift-edit: item %d: %s: %v\n", i, v.Address, err)
				return 1
			}
			if ungenReason != "" {
				fmt.Fprintf(stderr, "drift-edit: item %d: %s: %s\n", i, v.Address, ungenReason)
				return 2
			}
			if did {
				wrote++
				fmt.Fprintf(stdout, "drift-edit: wrote %s\n", v.Address)
			}
		}
	}
	if wrote == 0 {
		fmt.Fprintln(stdout, "INFO drift-edit: no edits needed — every pinned verdict already matches the checkout (verified no-op)")
	} else {
		fmt.Fprintf(stdout, "drift-edit: applied %d edit(s)\n", wrote)
	}
	return 0
}

// addressesFromAttrs returns the unique addresses named across attrs, in
// first-seen order — ProposalDigest sorts its own copy, so caller order here
// is not load-bearing, only completeness/uniqueness is.
func addressesFromAttrs(attrs []Attr) []string {
	seen := map[string]bool{}
	var out []string
	for _, a := range attrs {
		if !seen[a.Address] {
			seen[a.Address] = true
			out = append(out, a.Address)
		}
	}
	return out
}

// oobAdoptedFile is the constant target file every import write lands in
// (spec §7.2: "targetFile": "oob-adopted.tf" — "constant in v1"). Hardcoded
// here rather than trusted from the pinned importPayload.targetFile:
// targetFile is deliberately NOT part of the §5.4 digest formula (only
// arn/tfType/liveId/importBlock/skeletonHcl are), so a forged targetFile
// would not be caught by the digest cross-check alone. The pinned value is
// still compared against this constant (belt-and-braces tamper evidence,
// below) but the WRITE always targets this literal path, never an
// attacker-influenced one.
const oobAdoptedFile = "oob-adopted.tf"

// oobAdoptedBanner opens a freshly created oob-adopted.tf (spec §7.1 step 3:
// "create with a generated-by banner if absent"). ensureTrailingBlankLine
// normalizes its ending, so no trailing-newline bookkeeping is needed here.
const oobAdoptedBanner = `# Generated by catalogctl drift-edit — spec docs/superpowers/specs/2026-07-20-ccp-oob-provisioning-import.md §7.1.
# Out-of-band resources detected, reviewed, and imported here. Each satisfied
# import{} block is left in place as the provenance record (Terraform >=1.5
# treats an import block whose "to" is already in state as satisfied) —
# removing an adopted resource later means removing its import block in the
# SAME change (runbook D5's D4 interlock note), or the leftover block
# re-imports it on the next apply.
`

// runDriftEditImport drives every item's import write in order (spec §7.1),
// mirroring runDriftEditAdopt's per-item discipline. The checkout's
// watchlist is loaded ONCE (fail-closed doctrine matches Generate's own
// wiring: an unreadable/unparseable watchlist, or one whose
// creation_security_types key is entirely absent, refuses every import item
// in this request, never guessed item-by-item).
func runDriftEditImport(items []BundleRequestItem, repo, envDir string, stdout, stderr io.Writer) int {
	watchlist, watchlistErr := LoadWatchlist(repo)

	wrote := 0
	for i, item := range items {
		var p ImportParams
		if err := json.Unmarshal(item.Params, &p); err != nil {
			fmt.Fprintf(stderr, "drift-edit: item %d: pinned params: %v\n", i, err)
			return 3
		}
		addr := p.ImportPayload.Address
		if !p.ImportPayload.complete() {
			fmt.Fprintf(stderr, "drift-edit: item %d: pinned params carry an incomplete importPayload\n", i)
			return 3
		}
		if p.Finding.TfType == "" {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: pinned finding carries no tfType\n", i, addr)
			return 3
		}

		// (1) digest cross-check — tamper evidence. Recomputed over exactly
		// what §5.4 hashes.
		gotDigest := ImportProposalDigest([]string{addr}, p.Finding.Arn, p.Finding.TfType, p.Finding.LiveID, p.ImportPayload.ImportBlock, p.ImportPayload.SkeletonHcl)
		if gotDigest != p.ProposalDigest {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: digest mismatch — recomputed %s, pinned %s (tamper evidence)\n", i, addr, gotDigest, p.ProposalDigest)
			return 2
		}
		if p.ImportPayload.TargetFile != oobAdoptedFile {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: pinned targetFile %q does not match the v1 constant %q (tamper evidence)\n", i, addr, p.ImportPayload.TargetFile, oobAdoptedFile)
			return 2
		}

		// (2a) re-derive §5.2 eligibility — independent of points 1
		// (drift-propose) and 2 (the api's stored-report re-check): a forged
		// or tampered pinned finding is refused here even if every earlier
		// gate somehow let it through.
		if bucket, reason := ClassifyFinding(p.Finding); bucket != BucketImport {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: re-derived §5.2 eligibility failed (enforcement point 3): %s\n", i, addr, reason)
			return 2
		}
		// (2b) the checkout's own creation_security_types screen — again,
		// independent of what the pinned finding's securityFamily claims.
		if watchlistErr != nil {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: security watchlist unreadable in checkout — refusing every import: %v\n", i, addr, watchlistErr)
			return 2
		}
		if reason, hit := watchlist.ScreenCreationSecurity(p.Finding.TfType); hit {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: %s\n", i, addr, reason)
			return 2
		}
		// (2c) payload prescan — again.
		if reason, ok := PrescanImportPayload(p.ImportPayload.ImportBlock, p.ImportPayload.SkeletonHcl); !ok {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: %s\n", i, addr, reason)
			return 2
		}
		// (2d) collision — the address already resolves in the checkout (a
		// re-run after a prior successful import lands here correctly).
		if _, err, _ := hclops.Locate(envDir, addr); err == nil {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: address already resolves in the checkout — already managed, cannot import\n", i, addr)
			return 2
		}

		// (3) the write — fresh disk bytes per item so batched imports
		// compose (mirrors ApplyAdopt's own per-item re-read discipline).
		if err := appendImportBlock(envDir, p.ImportPayload); err != nil {
			fmt.Fprintf(stderr, "drift-edit: item %d: %s: %v\n", i, addr, err)
			return 1
		}
		wrote++
		fmt.Fprintf(stdout, "drift-edit: imported %s\n", addr)
	}
	if wrote == 0 {
		fmt.Fprintln(stdout, "INFO drift-edit: no imports to apply")
	} else {
		fmt.Fprintf(stdout, "drift-edit: applied %d import(s)\n", wrote)
	}
	return 0
}

// appendImportBlock appends payload's pinned importBlock then skeletonHcl —
// exactly the reviewed bytes, one blank line between blocks (spec §7.1 step
// 3) — to envDir/oob-adopted.tf, creating it with the generated-by banner
// when absent. Re-reads the file fresh from disk on every call (never caches
// across items), so a batch of imports into the SAME file composes correctly.
func appendImportBlock(envDir string, payload FindingImportPayload) error {
	target := filepath.Join(envDir, oobAdoptedFile)
	var buf []byte
	cur, err := os.ReadFile(target)
	switch {
	case err == nil:
		buf = cur
	case os.IsNotExist(err):
		buf = []byte(oobAdoptedBanner)
	default:
		return fmt.Errorf("read %s: %w", target, err)
	}

	buf = ensureTrailingBlankLine(buf)
	buf = append(buf, normalizeTrailingNewline(payload.ImportBlock)...)
	buf = append(buf, '\n') // the blank line between import{} and resource{}
	buf = append(buf, normalizeTrailingNewline(payload.SkeletonHcl)...)

	if err := os.WriteFile(target, buf, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", target, err)
	}
	return nil
}

// ensureTrailingBlankLine strips every trailing newline from buf, then (when
// buf is non-empty) re-appends exactly two — "...\n\n", i.e. one blank line
// — so whatever is appended next is always separated from the banner or a
// previously composed item by exactly one blank line. An empty buf is
// returned unchanged (nothing to separate from).
func ensureTrailingBlankLine(buf []byte) []byte {
	for len(buf) > 0 && buf[len(buf)-1] == '\n' {
		buf = buf[:len(buf)-1]
	}
	if len(buf) == 0 {
		return buf
	}
	return append(buf, '\n', '\n')
}

// normalizeTrailingNewline trims every trailing newline from s and
// re-appends exactly one — the pinned importBlock/skeletonHcl strings are
// already single-trailing-newline by construction (gen-imports.py /
// -generate-config-out's own machine-formatted output), but this makes the
// composition robust to a caller that supplied zero or several.
func normalizeTrailingNewline(s string) []byte {
	b := []byte(strings.TrimRight(s, "\n"))
	return append(b, '\n')
}

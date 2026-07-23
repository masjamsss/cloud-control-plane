package driftpropose

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// ProposalsSchema is the schema name proposals.json carries (§6.1).
const ProposalsSchema = "ccp.drift-proposals/v1"

// restoreDisarmedReason is the byte-pinned ungenerable reason plan
// 2026-07-20-drift-restore-tranche.md §2.2 gives a RESTORE-bucket verdict when
// --enable-restore is not set: the honest arming reason, replacing the now-
// unreachable oob_deletion class note (partition.go's knownClasses entry).
const restoreDisarmedReason = "restore proposals are not enabled in this deployment's generation command (--enable-restore) — meanwhile: re-assert code by hand per runbook D4 + docs/runbooks/state-recovery.md"

// ProposalsDoc is the whole `--out proposals.json` document (spec §6.1).
type ProposalsDoc struct {
	Schema      string        `json:"schema"`
	BaseCommit  string        `json:"baseCommit"`
	Proposals   []Proposal    `json:"proposals"`
	Ungenerable []Ungenerable `json:"ungenerable"`
}

// GenOptions is generate()'s flag-gated lane selection (plan
// 2026-07-20-drift-restore-tranche.md §2.2): the Go zero value GenOptions{} is
// byte-identical to today's un-flagged Generate() — every field defaults to
// false/off, matching the "--enable-import precedent" every additive
// generation lane in this package follows (spec 2026-07-20-ccp-oob-
// provisioning-import.md §5.1, restated for restore). command.go's
// --enable-import/--enable-restore flags are this struct's only producer
// beyond Generate/GenerateWithImport's own byte-compatible wrapping below.
type GenOptions struct {
	EnableImport  bool
	EnableRestore bool
}

// Generate is the pure engine entry point (spec §6.1): partition every verdict via
// ClassifyByFields, generate its adopt/revert/restore proposal or record the
// mechanical reason it cannot be generated, and return the whole proposals.json
// document. Output is sorted by address so the same envelope+checkout always yields
// byte-identical bytes regardless of the verdicts[] order in the source envelope —
// digest idempotency (§2.4) already makes each PROPOSAL stable; this makes the
// DOCUMENT stable too.
//
// repo is the scratch checkout root; root is the state root inside it to scan for
// *.tf (e.g. "environments/prod") — also used as the diff's repo-relative label
// prefix, exactly like `edit`'s --diff-prefix. Only report.verdicts[] is
// considered; report.absorbed[] entries carry no actionable verdict fields at all
// (§6.2 partitions "every verdict") and are never generable by construction.
//
// spec addendum A1 (F4, "the fourth screen"): the checkout's OWN
// scripts/drift/security-watchlist.json is loaded ONCE (repo root, independent
// of root) and every ADOPT-bucket verdict is screened against it before
// GenerateAdopt ever runs — enforcement point 1's belt-and-braces half, catching
// a forged/relabeled envelope that ClassifyByFields' own field-trust (§8 point 1)
// cannot. Fail-closed: a missing or unparseable watchlist file makes the ENTIRE
// adopt bucket ungenerable (never guessed verdict-by-verdict); revert-bucket,
// restore-bucket, and already-ungenerable verdicts are entirely unaffected — the
// fourth screen only ever narrows the adopt lane (§8: "the shortcut stays
// sealed"; restore-tranche §2.1: "the fourth screen is inapplicable by
// construction" for restore specifically — it screens live VALUES entering
// code, and a restore carries none).
//
// Generate is byte-identical to GenerateOpts(env, repo, root, GenOptions{}) —
// both import and restore stay off, so an envelope carrying a sweep section
// and/or restore-eligible verdicts produces the EXACT SAME proposals.json
// through this entry point as one without (spec 2026-07-20-ccp-oob-
// provisioning-import.md §5.1: "off ⇒ behavior today, byte-identical"; restore
// tranche §2.2: the same doctrine, restated for --enable-restore).
func Generate(env *Envelope, repo, root string) (*ProposalsDoc, error) {
	return GenerateOpts(env, repo, root, GenOptions{})
}

// GenerateWithImport extends Generate with spec
// 2026-07-20-ccp-oob-provisioning-import.md §5.1's import flavor: when
// enableImport is true and env.Sweep is present, envelope.sweep.findings is
// ADDITIONALLY partitioned via ClassifyFinding and eligible findings emit
// import proposals into the SAME proposals.json (schema name unchanged;
// flavor:"import" is additive) — command.go's `--enable-import` flag is this
// parameter's only caller. enableImport=false is byte-identical to Generate.
// A byte-compatible wrapper kept for every existing caller (spec's own
// pre-restore-tranche signature); GenerateOpts is the general entry point.
func GenerateWithImport(env *Envelope, repo, root string, enableImport bool) (*ProposalsDoc, error) {
	return GenerateOpts(env, repo, root, GenOptions{EnableImport: enableImport})
}

// GenerateOpts is generate()'s exported entry point, taking the full
// GenOptions struct (plan 2026-07-20-drift-restore-tranche.md §2.2). This is
// what command.go calls once it has parsed BOTH --enable-import and
// --enable-restore; Generate/GenerateWithImport above stay as byte-compatible
// wrappers over it for every caller that only ever knew about one flag.
func GenerateOpts(env *Envelope, repo, root string, opts GenOptions) (*ProposalsDoc, error) {
	return generate(env, repo, root, opts)
}

func generate(env *Envelope, repo, root string, opts GenOptions) (*ProposalsDoc, error) {
	envDir := filepath.Join(repo, root)
	doc := &ProposalsDoc{
		Schema:     ProposalsSchema,
		BaseCommit: gitHead(repo),
	}

	watchlist, watchlistErr := LoadWatchlist(repo)

	for _, v := range env.Report.Verdicts {
		bucket, reason := ClassifyByFields(v)
		switch bucket {
		case BucketAdopt:
			if watchlistErr != nil {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{
					Address: v.Address, Class: v.Class,
					Reason: fmt.Sprintf("security watchlist unreadable in checkout — refusing every adopt: %v", watchlistErr),
				})
				continue
			}
			if wReason, hit := watchlist.ScreenVerdict(v); hit {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: v.Address, Class: v.Class, Reason: wReason})
				continue
			}
			p, ungenReason, err := GenerateAdopt(v, envDir, root)
			if err != nil {
				return nil, err
			}
			if ungenReason != "" {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: v.Address, Class: v.Class, Reason: ungenReason})
				continue
			}
			doc.Proposals = append(doc.Proposals, *p)
		case BucketRevert:
			p, ungenReason, err := GenerateRevert(v, envDir)
			if err != nil {
				return nil, err
			}
			if ungenReason != "" {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: v.Address, Class: v.Class, Reason: ungenReason})
				continue
			}
			doc.Proposals = append(doc.Proposals, *p)
		case BucketRestore:
			// plan 2026-07-20-drift-restore-tranche.md §2.2: flag OFF ⇒
			// ungenerable with the honest arming reason (replaces the now-stale
			// class note, see partition.go); flag ON ⇒ GenerateRestore's own
			// checkout-dependent refinement. Deliberately NO fourth-screen
			// watchlist consultation either way (§2.1's "Deliberate security
			// stance" — restore re-creates from code already reviewed on main,
			// the opposite direction from import's unknown-actor adoption).
			if !opts.EnableRestore {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: v.Address, Class: v.Class, Reason: restoreDisarmedReason})
				continue
			}
			p, ungenReason, err := GenerateRestore(v, envDir)
			if err != nil {
				return nil, err
			}
			if ungenReason != "" {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: v.Address, Class: v.Class, Reason: ungenReason})
				continue
			}
			doc.Proposals = append(doc.Proposals, *p)
		default: // BucketUngenerable
			doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: v.Address, Class: v.Class, Reason: reason})
		}
	}

	// spec §5.2/§5.3: the import bucket, additive and flag-gated. Every
	// screen below is INDEPENDENT of ClassifyFinding's own field-only F-2
	// signal (finding.SecurityFamily) — re-derived from the CHECKOUT's own
	// creation_security_types (screen 1) and the payload's own bytes
	// (prescan), never trusting what the finding claims (§8 invariant 1's
	// "three independent screens").
	if opts.EnableImport && env.Sweep != nil {
		for _, f := range env.Sweep.Findings {
			bucket, reason := ClassifyFinding(f)
			if bucket != BucketImport {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: findingKey(f), Class: f.Class, Reason: reason})
				continue
			}
			if watchlistErr != nil {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{
					Address: findingKey(f), Class: f.Class,
					Reason: fmt.Sprintf("security watchlist unreadable in checkout — refusing every import: %v", watchlistErr),
				})
				continue
			}
			if wReason, hit := watchlist.ScreenCreationSecurity(f.TfType); hit {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: findingKey(f), Class: f.Class, Reason: wReason})
				continue
			}
			if pReason, clean := PrescanImportPayload(f.ImportPayload.ImportBlock, f.ImportPayload.SkeletonHcl); !clean {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: findingKey(f), Class: f.Class, Reason: pReason})
				continue
			}
			p, ungenReason, err := GenerateImport(f, envDir)
			if err != nil {
				return nil, err
			}
			if ungenReason != "" {
				doc.Ungenerable = append(doc.Ungenerable, Ungenerable{Address: findingKey(f), Class: f.Class, Reason: ungenReason})
				continue
			}
			doc.Proposals = append(doc.Proposals, *p)
		}
	}

	sort.Slice(doc.Proposals, func(i, j int) bool { return doc.Proposals[i].Addresses[0] < doc.Proposals[j].Addresses[0] })
	sort.Slice(doc.Ungenerable, func(i, j int) bool { return doc.Ungenerable[i].Address < doc.Ungenerable[j].Address })
	return doc, nil
}

// gitHead best-effort reads the checkout's current commit (spec §6.1: "baseCommit":
// "<checkout HEAD>"), mirroring internal/onboard's realGitHead. It never fails the
// whole command: a checkout that genuinely isn't a git repository (a bare directory
// fixture in a test, say) still produces a complete, valid, deterministic
// proposals.json — baseCommit is provenance, not something any partition or edit
// decision reads.
func gitHead(repo string) string {
	cmd := exec.Command("git", "-C", repo, "rev-parse", "HEAD")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return ""
	}
	return strings.TrimSpace(out.String())
}

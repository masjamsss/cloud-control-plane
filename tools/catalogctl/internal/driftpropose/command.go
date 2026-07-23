package driftpropose

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
)

// init installs cli.DriftPropose so cli.Run stays the single entrypoint (mirrors the
// plancheck/windowcheck seams; avoids an import cycle since cli imports nothing here).
func init() { cli.DriftPropose = run }

// run is the `drift-propose` subcommand (spec §6.1, concrete invocation contract):
//
//	catalogctl drift-propose \
//	  --envelope  <path to the stored ccp.drift/v1 envelope> \
//	  --repo      <scratch checkout of main>  --root environments/prod \
//	  --out       <proposals.json> \
//	  [--enable-import] [--enable-restore]
//
// Exit 0 = proposals.json written (possibly zero proposals; all-ungenerable is a
// valid outcome) · exit 3 = envelope unreadable/failed validation · exit 4 =
// checkout unusable · exit 1 = internal. Pure function of (envelope bytes, checkout
// tree): no network, no AWS, no LLM, no wall-clock in the output (ADR-0007) — the
// one process this subcommand spawns (`git rev-parse HEAD`, best-effort, see
// generate.go's gitHead) reads only the local checkout already on disk.
//
// --enable-import (spec 2026-07-20-ccp-oob-provisioning-import.md §5.1/§9):
// off by default — omitting it is byte-identical to every existing invocation
// (GenerateWithImport(..., false) == Generate). The operator arms the import
// lane by editing CCP_DRIFT_GEN_CMD to add this flag, never by a code change.
//
// --enable-restore (plan 2026-07-20-drift-restore-tranche.md §2.2): the exact
// same off-by-default, edit-CCP_DRIFT_GEN_CMD-to-arm precedent, for the
// restore flavor. Omitting it is byte-identical to every existing invocation
// too — GenerateOpts(..., GenOptions{}) == Generate regardless of how many
// oob_deletion verdicts the envelope carries.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("drift-propose", flag.ContinueOnError)
	fs.SetOutput(stderr)
	envelopePath := fs.String("envelope", "", "path to the stored ccp.drift/v1 envelope")
	repo := fs.String("repo", "", "scratch checkout of main")
	root := fs.String("root", "", "state root inside --repo to scan for *.tf (e.g. environments/prod)")
	out := fs.String("out", "", "output path for proposals.json")
	enableImport := fs.Bool("enable-import", false, "additionally partition envelope.sweep.findings and emit import proposals (spec oob-provisioning-import §5.1); off is byte-identical to today")
	enableRestore := fs.Bool("enable-restore", false, "additionally emit restore proposals for restore-eligible oob_deletion verdicts (plan 2026-07-20-drift-restore-tranche.md §2.2); off is byte-identical to today")
	if err := fs.Parse(args); err != nil {
		return 3
	}
	if *envelopePath == "" || *repo == "" || *root == "" || *out == "" {
		fmt.Fprintln(stderr, "drift-propose: --envelope, --repo, --root and --out are all required")
		return 3
	}

	env, err := LoadEnvelope(*envelopePath)
	if err != nil {
		fmt.Fprintf(stderr, "drift-propose: %v\n", err)
		return 3
	}

	envDir := filepath.Join(*repo, *root)
	if info, statErr := os.Stat(envDir); statErr != nil || !info.IsDir() {
		fmt.Fprintf(stderr, "drift-propose: checkout root %s is not a usable directory: %v\n", envDir, statErr)
		return 4
	}

	doc, err := GenerateOpts(env, *repo, *root, GenOptions{EnableImport: *enableImport, EnableRestore: *enableRestore})
	if err != nil {
		fmt.Fprintf(stderr, "drift-propose: %v\n", err)
		return 1
	}

	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "drift-propose: %v\n", err)
		return 1
	}
	b = append(b, '\n')
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		fmt.Fprintf(stderr, "drift-propose: %v\n", err)
		return 1
	}

	fmt.Fprintf(stdout, "drift-propose: wrote %d proposal(s), %d ungenerable to %s\n", len(doc.Proposals), len(doc.Ungenerable), *out)
	return 0
}

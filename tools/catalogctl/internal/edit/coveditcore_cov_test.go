package edit

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// coveditcore_cov_test.go drives the pipeline core — edit.go (flag parse, the
// loaders, dispatch, the resolution gates, the in-place / file / create lanes and
// the diff+atomic-write output), create.go, createsupport.go and instantiate.go —
// through the REAL entrypoint `run`, asserting the exit-code contract from the
// README's safety model: 0 ok · 2 `REFUSE <CODE>: <reason>` on stderr · 3
// resolution/schema · 1 internal. Every fixture is synthetic and hermetic: a
// throwaway manifest catalog, request YAML, env dir and schemadump per case, so no
// test depends on the repo's own catalog, schemadump or git state.

// coveditcoreReqID satisfies request.go's REQ-<Crockford-ulid> shape.
const coveditcoreReqID = "REQ-00000000000000000000000000"

// coveditcoreSchemaDump is a minimal tools/schemadump projection: one reflected
// resource type declaring exactly one nested block (good_block) plus a scalar
// attribute. Passing it via --schema keeps the schema-aware guards armed AND
// hermetic — the committed 18 MB provider dump is never touched.
const coveditcoreSchemaDump = `{"resources":{"aws_coveditcore_thing":{"attributes":{` +
	`"good_block":{"nesting_mode":"list","block":{"attributes":{}}},` +
	`"size":{}}}}}`

// coveditcoreVolume is a fmt-canonical single-resource env file.
const coveditcoreVolume = "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n}\n"

// coveditcoreFailWriter is a stdout that always fails, so the pipeline's
// "could not emit the diff" branch (exit 1) is exercised without a real broken pipe.
type coveditcoreFailWriter struct{}

func (coveditcoreFailWriter) Write([]byte) (int, error) {
	return 0, errors.New("coveditcore: stdout is closed")
}

// coveditcoreCase describes one `run` invocation.
type coveditcoreCase struct {
	ops         []manifests.Op    // marshalled into a one-file ServiceManifest catalog
	rawManifest string            // written verbatim instead of ops when non-empty
	item        string            // request item (defaults to ops[0].ID)
	params      map[string]any    // request params
	envFiles    map[string]string // files written into a fresh env dir
	envDir      string            // used verbatim when set (e.g. a path that does not exist)
	schema      string            // --schema (defaults to the synthetic dump above)
	reqPath     string            // --request override
	diffOut     string
	diffPrefix  string
	estateTZ    string
	dryRun      bool
	stdout      io.Writer // defaults to a capturing buffer
}

type coveditcoreResult struct {
	code   int
	stdout string
	stderr string
	envDir string
}

func coveditcoreWriteFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// coveditcoreRun materialises the case on disk and runs the edit subcommand.
func coveditcoreRun(t *testing.T, c coveditcoreCase) coveditcoreResult {
	t.Helper()
	base := t.TempDir()

	envDir := c.envDir
	if envDir == "" {
		envDir = filepath.Join(base, "env")
		if err := os.MkdirAll(envDir, 0o755); err != nil {
			t.Fatal(err)
		}
		for name, body := range c.envFiles {
			coveditcoreWriteFile(t, envDir, name, body)
		}
	}

	manDir := filepath.Join(base, "manifests")
	if err := os.MkdirAll(manDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if c.rawManifest != "" {
		coveditcoreWriteFile(t, manDir, "cov.json", c.rawManifest)
	} else {
		b, err := json.Marshal(map[string]any{"service": "cov", "operations": c.ops})
		if err != nil {
			t.Fatal(err)
		}
		coveditcoreWriteFile(t, manDir, "cov.json", string(b))
	}

	reqPath := c.reqPath
	if reqPath == "" {
		item := c.item
		if item == "" && len(c.ops) > 0 {
			item = c.ops[0].ID
		}
		params := c.params
		if params == nil {
			params = map[string]any{}
		}
		b, err := yaml.Marshal(map[string]any{
			"schema": "ccp.request/v1", "id": coveditcoreReqID, "item": item, "params": params,
		})
		if err != nil {
			t.Fatal(err)
		}
		reqPath = coveditcoreWriteFile(t, base, "request.yaml", string(b))
	}

	schema := c.schema
	if schema == "" {
		schema = coveditcoreWriteFile(t, base, "schema.json", coveditcoreSchemaDump)
	}

	args := []string{
		"--request", reqPath, "--manifests", manDir, "--env", envDir, "--schema", schema,
	}
	if c.dryRun {
		args = append(args, "--dry-run")
	}
	if c.diffOut != "" {
		args = append(args, "--diff-out", c.diffOut)
	}
	if c.diffPrefix != "" {
		args = append(args, "--diff-prefix", c.diffPrefix)
	}
	if c.estateTZ != "" {
		args = append(args, "--estate-tz", c.estateTZ)
	}

	var out bytes.Buffer
	var stderr bytes.Buffer
	stdout := c.stdout
	if stdout == nil {
		stdout = &out
	}
	code := run(args, stdout, &stderr)
	return coveditcoreResult{code: code, stdout: out.String(), stderr: stderr.String(), envDir: envDir}
}

func coveditcoreWantExit(t *testing.T, got coveditcoreResult, want int) {
	t.Helper()
	if got.code != want {
		t.Fatalf("exit %d, want %d; stderr=%q stdout=%q", got.code, want, got.stderr, got.stdout)
	}
}

func coveditcoreWantStderr(t *testing.T, got coveditcoreResult, sub string) {
	t.Helper()
	if !strings.Contains(got.stderr, sub) {
		t.Fatalf("stderr = %q, want it to contain %q", got.stderr, sub)
	}
}

// coveditcoreWantRefusal pins the whole exit-2 contract: code 2 AND the exact
// `REFUSE <CODE>: ` line shape on stderr.
func coveditcoreWantRefusal(t *testing.T, got coveditcoreResult, code string) {
	t.Helper()
	coveditcoreWantExit(t, got, 2)
	coveditcoreWantStderr(t, got, "REFUSE "+code+": ")
}

// coveditcoreOp builds an op. Op.Target is an anonymous struct, so the caller sets
// its fields on the returned value.
func coveditcoreOp(id, codemod, resourceType string, params ...manifests.Param) manifests.Op {
	op := manifests.Op{ID: id, Service: "cov", CodemodOp: codemod, Params: params}
	op.Target.ResourceType = resourceType
	return op
}

// coveditcoreTarget is the inventory locator param the in-place / file verbs need.
var coveditcoreTarget = manifests.Param{Name: "target", Source: "inventory"}

// coveditcoreSetSize is a set_attribute op over the coveditcoreVolume fixture.
func coveditcoreSetSize() manifests.Op {
	op := coveditcoreOp("cov-set-size", "set_attribute", "aws_ebs_volume",
		coveditcoreTarget,
		manifests.Param{Name: "new_size", Source: "user_input", Type: "number"},
	)
	op.Target.Attr = "size"
	return op
}

// ── run: flag parsing and the loaders (exit 3 before any verdict) ────────────

// TestCoveditcoreRunFlagAndLoaderGates: every failure BEFORE a target is resolved
// is a schema/resolution error — exit 3 — and never a write. Each gate is checked
// in the order run applies it: flag parse, estate config, request, manifests, op
// lookup, codemodOp dispatch.
func TestCoveditcoreRunFlagAndLoaderGates(t *testing.T) {
	t.Run("undefined flag exits 3", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		if code := run([]string{"--not-a-real-flag"}, &stdout, &stderr); code != 3 {
			t.Fatalf("exit %d, want 3; stderr=%q", code, stderr.String())
		}
		if !strings.Contains(stderr.String(), "flag provided but not defined") {
			t.Fatalf("stderr = %q, want the flag-parse error", stderr.String())
		}
		if stdout.Len() != 0 {
			t.Fatalf("stdout = %q, want nothing written on a flag error", stdout.String())
		}
	})

	t.Run("unresolvable estate timezone exits 3", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := run([]string{"--estate-tz", "Mars/Olympus_Mons"}, &stdout, &stderr)
		if code != 3 {
			t.Fatalf("exit %d, want 3; stderr=%q", code, stderr.String())
		}
		coveditcoreWantStderr(t, coveditcoreResult{stderr: stderr.String()},
			"does not resolve to a known IANA timezone")
	})

	t.Run("unreadable request exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:     []manifests.Op{coveditcoreSetSize()},
			reqPath: filepath.Join(t.TempDir(), "absent.yaml"),
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, "absent.yaml")
	})

	t.Run("request with an unknown top-level field exits 3", func(t *testing.T) {
		dir := t.TempDir()
		p := coveditcoreWriteFile(t, dir, "request.yaml",
			"schema: ccp.request/v1\nid: "+coveditcoreReqID+"\nitem: cov-set-size\nbogus_key: 1\n")
		got := coveditcoreRun(t, coveditcoreCase{ops: []manifests.Op{coveditcoreSetSize()}, reqPath: p})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, "unknown top-level field")
	})

	t.Run("undecodable manifest catalog exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			rawManifest: `{"service":"cov","operations":[{"id":"cov-set-size","typo":true}]}`,
			item:        "cov-set-size",
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, "cov.json")
	})

	t.Run("unknown request item exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:  []manifests.Op{coveditcoreSetSize()},
			item: "cov-not-in-the-catalog",
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, `unknown op "cov-not-in-the-catalog"`)
	})

	t.Run("unknown codemodOp exits 3", func(t *testing.T) {
		op := coveditcoreOp("cov-frob", "frobnicate", "aws_ebs_volume", coveditcoreTarget)
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_ebs_volume.v"},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, `unknown codemodOp "frobnicate"`)
	})
}

// ── run: resolution gates (address, locate, fmt) ─────────────────────────────

// TestCoveditcoreRunResolutionGates: an op whose target address cannot be resolved
// — no inventory param, absent, or ambiguous — is a resolution error (exit 3), and
// a non-fmt-canonical target file is an exit-2 refusal. None of them writes.
func TestCoveditcoreRunResolutionGates(t *testing.T) {
	t.Run("op with no inventory param exits 3", func(t *testing.T) {
		op := coveditcoreOp("cov-no-inv", "set_attribute", "aws_ebs_volume",
			manifests.Param{Name: "new_size", Source: "user_input", Type: "number"})
		op.Target.Attr = "size"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, `op "cov-no-inv" has no inventory param`)
	})

	t.Run("inventory param missing from the request exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, `missing inventory param "target"`)
	})

	t.Run("address not found exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.absent", "new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, `address "aws_ebs_volume.absent" not found`)
	})

	t.Run("ambiguous address exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreSetSize()},
			params: map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{
				"a.tf": coveditcoreVolume,
				"b.tf": coveditcoreVolume,
			},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, "matches 2 blocks (ambiguous)")
	})

	t.Run("fmt-dirty target refuses FMT_DIRTY and writes nothing", func(t *testing.T) {
		dirty := "resource \"aws_ebs_volume\" \"v\" {\n      size   =    100\n}\n"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{"main.tf": dirty},
		})
		coveditcoreWantRefusal(t, got, "FMT_DIRTY")
		coveditcoreWantStderr(t, got, "main.tf is not fmt-canonical")
		b, err := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if err != nil || string(b) != dirty {
			t.Fatalf("file changed on refusal: %q (err %v)", b, err)
		}
	})
}

// ── run: the in-place transformer lane ───────────────────────────────────────

// TestCoveditcoreRunInPlaceLane pins how the in-place lane maps a transformer's
// three outcomes: a refusal → exit 2 with the REFUSE line, a resolution-wrapped
// error → exit 3, a plain internal error → exit 1, and byte-identical bytes →
// exit 0 with an empty diff and no write.
func TestCoveditcoreRunInPlaceLane(t *testing.T) {
	t.Run("internal error exits 1", func(t *testing.T) {
		// An op with no value param has nothing to write — a manifest inconsistency.
		op := coveditcoreOp("cov-valueless", "set_attribute", "aws_ebs_volume", coveditcoreTarget)
		op.Target.Attr = "size"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_ebs_volume.v"},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "has no value param")
	})

	t.Run("reference resolution failure exits 3", func(t *testing.T) {
		op := coveditcoreOp("cov-ref", "set_attribute", "aws_ebs_volume",
			coveditcoreTarget,
			manifests.Param{Name: "kms", Source: "inventory", Role: "reference", RefAttr: "arn"},
		)
		op.Target.Attr = "kms_key_id"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_ebs_volume.v", "kms": "aws_kms_key.absent"},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, `address "aws_kms_key.absent" not found`)
	})

	t.Run("refusal exits 2 and leaves the file untouched", func(t *testing.T) {
		op := coveditcoreSetSize()
		op.Target.Attr = "metadata_options.http_tokens" // a dotted LHS is invalid HCL
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantRefusal(t, got, "UNSUPPORTED_PATH")
		b, _ := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if string(b) != coveditcoreVolume {
			t.Fatalf("file = %q, want it untouched on a refusal", b)
		}
	})

	t.Run("verified no-op exits 0 with an empty diff and no write", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 100},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 0)
		if got.stdout != "" {
			t.Fatalf("stdout = %q, want an empty diff for a no-op", got.stdout)
		}
		b, _ := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if string(b) != coveditcoreVolume {
			t.Fatalf("file = %q, want it untouched for a no-op", b)
		}
	})
}

// ── run: the applied-edit output (diff, --dry-run, --diff-out, atomic write) ──

// TestCoveditcoreRunAppliesAndEmitsDiff: on the accept path the file is rewritten
// atomically, the unified diff goes to stdout under the --diff-prefix label, and
// --dry-run suppresses the write while still emitting the identical diff.
func TestCoveditcoreRunAppliesAndEmitsDiff(t *testing.T) {
	want := "resource \"aws_ebs_volume\" \"v\" {\n  size = 200\n}\n"

	t.Run("applies the edit and prints the diff", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 0)
		b, err := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != want {
			t.Fatalf("applied file =\n%q\nwant\n%q", b, want)
		}
		for _, sub := range []string{
			"--- a/environments/prod/main.tf",
			"+++ b/environments/prod/main.tf",
			"-  size = 100",
			"+  size = 200",
		} {
			if !strings.Contains(got.stdout, sub) {
				t.Fatalf("diff = %q, want it to contain %q", got.stdout, sub)
			}
		}
		// The atomic write must leave no temp file behind.
		entries, _ := os.ReadDir(got.envDir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".catalogctl-") {
				t.Fatalf("temp file %q survived the atomic write", e.Name())
			}
		}
	})

	t.Run("dry-run emits the diff but writes nothing", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
			dryRun:   true,
		})
		coveditcoreWantExit(t, got, 0)
		b, _ := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if string(b) != coveditcoreVolume {
			t.Fatalf("file = %q, want it untouched under --dry-run", b)
		}
		if !strings.Contains(got.stdout, "+  size = 200") {
			t.Fatalf("diff = %q, want the added line", got.stdout)
		}
	})

	t.Run("--diff-prefix labels both diff sides", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:        []manifests.Op{coveditcoreSetSize()},
			params:     map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles:   map[string]string{"main.tf": coveditcoreVolume},
			dryRun:     true,
			diffPrefix: "environments/staging",
		})
		coveditcoreWantExit(t, got, 0)
		if !strings.Contains(got.stdout, "--- a/environments/staging/main.tf") {
			t.Fatalf("diff = %q, want the staging label", got.stdout)
		}
	})

	t.Run("--diff-out mirrors stdout byte for byte", func(t *testing.T) {
		out := filepath.Join(t.TempDir(), "evidence.diff")
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
			dryRun:   true,
			diffOut:  out,
		})
		coveditcoreWantExit(t, got, 0)
		b, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != got.stdout {
			t.Fatalf("--diff-out =\n%q\nstdout =\n%q", b, got.stdout)
		}
	})

	t.Run("unwritable --diff-out exits 1", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
			dryRun:   true,
			diffOut:  filepath.Join(t.TempDir(), "no-such-dir", "evidence.diff"),
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "no such file or directory")
	})

	t.Run("failing stdout exits 1", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreSetSize()},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_size": 200},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
			dryRun:   true,
			stdout:   coveditcoreFailWriter{},
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "coveditcore: stdout is closed")
	})
}

// ── run: the file-transformer lane ───────────────────────────────────────────

// TestCoveditcoreRunFileTransformerLane: the whole-file verbs share the same
// outcome mapping as the in-place lane — refusal → 2, errResolution → 3, plain
// error → 1 — and an accepted rewrite emits the diff and writes the new file.
func TestCoveditcoreRunFileTransformerLane(t *testing.T) {
	removeOp := coveditcoreOp("cov-remove", "remove_block", "aws_ebs_volume", coveditcoreTarget)

	t.Run("remove_block rewrites the whole file", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{removeOp},
			params:   map[string]any{"target": "aws_ebs_volume.v"},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 0)
		b, err := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if err != nil {
			t.Fatal(err)
		}
		if len(b) != 0 {
			t.Fatalf("file = %q, want the block removed entirely", b)
		}
		if !strings.Contains(got.stdout, "-resource \"aws_ebs_volume\" \"v\" {") {
			t.Fatalf("diff = %q, want the removed resource line", got.stdout)
		}
	})

	t.Run("remove_block refuses PREVENT_DESTROY", func(t *testing.T) {
		protected := "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{removeOp},
			params:   map[string]any{"target": "aws_ebs_volume.v"},
			envFiles: map[string]string{"main.tf": protected},
		})
		coveditcoreWantRefusal(t, got, "PREVENT_DESTROY")
		b, _ := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if string(b) != protected {
			t.Fatalf("file changed on a PREVENT_DESTROY refusal: %q", b)
		}
	})

	t.Run("moved_block with identical from/to exits 3", func(t *testing.T) {
		op := coveditcoreOp("cov-moved", "moved_block", "aws_ebs_volume",
			coveditcoreTarget,
			manifests.Param{Name: "new_name", Source: "user_input", Type: "string"},
		)
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_ebs_volume.v", "new_name": "v"},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, "moved from == to")
	})

	t.Run("moved_block with no new-name param exits 1", func(t *testing.T) {
		op := coveditcoreOp("cov-moved-bare", "moved_block", "aws_ebs_volume", coveditcoreTarget)
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_ebs_volume.v"},
			envFiles: map[string]string{"main.tf": coveditcoreVolume},
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "missing new name param")
	})
}

// ── run: the append_block schema gate ────────────────────────────────────────

// TestCoveditcoreRunAppendBlockSchemaGate: an explicit but unreadable --schema is a
// hard exit-3 (fail-closed), while a readable dump that does not declare the
// target block refuses UNKNOWN_BLOCK_TYPE before the file is opened.
func TestCoveditcoreRunAppendBlockSchemaGate(t *testing.T) {
	op := coveditcoreOp("cov-append", "append_block", "aws_coveditcore_thing",
		coveditcoreTarget,
		manifests.Param{Name: "field", Source: "user_input", Type: "string"},
	)
	op.Target.Block = "no_such_block"
	env := map[string]string{"main.tf": "resource \"aws_coveditcore_thing\" \"t\" {\n  size = 1\n}\n"}

	t.Run("unreadable --schema exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_coveditcore_thing.t", "field": "x"},
			envFiles: env,
			schema:   filepath.Join(t.TempDir(), "absent-schema.json"),
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, "schema: ")
	})

	t.Run("undeclared nested block refuses UNKNOWN_BLOCK_TYPE", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"target": "aws_coveditcore_thing.t", "field": "x"},
			envFiles: env,
		})
		coveditcoreWantRefusal(t, got, RefuseUnknownBlockType)
	})
}

// ── run: the create_resource lane ────────────────────────────────────────────

// coveditcoreCreateOp is a create op over the synthetic reflected type: one
// role:"key" param naming the resource, one scalar attribute.
func coveditcoreCreateOp() manifests.Op {
	return coveditcoreOp("cov-create", "create_resource", "aws_coveditcore_thing",
		manifests.Param{Name: "name", Source: "user_input", Type: "string", Role: "key"},
		manifests.Param{Name: "size", Source: "user_input", Type: "number"},
	)
}

const coveditcoreCreated = "resource \"aws_coveditcore_thing\" \"finance_interface\" {\n  size = 10\n}\n"

var coveditcoreCreateParams = map[string]any{"name": "Finance Interface", "size": 10}

// TestCoveditcoreRunCreateLaneAccepts: the pre-locate create branch authors the
// service file at EOF, emits an additions-only diff and honours --dry-run.
func TestCoveditcoreRunCreateLaneAccepts(t *testing.T) {
	t.Run("authors a brand-new service file", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreCreateOp()},
			params: coveditcoreCreateParams,
		})
		coveditcoreWantExit(t, got, 0)
		b, err := os.ReadFile(filepath.Join(got.envDir, "cov.tf"))
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != coveditcoreCreated {
			t.Fatalf("authored file =\n%q\nwant\n%q", b, coveditcoreCreated)
		}
		if !strings.Contains(got.stdout, "+++ b/environments/prod/cov.tf") {
			t.Fatalf("diff = %q, want the cov.tf label", got.stdout)
		}
		// A create's diff is all-additions: no body line may start with '-'.
		for _, line := range strings.Split(got.stdout, "\n") {
			if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
				t.Fatalf("create diff has a removal line %q:\n%s", line, got.stdout)
			}
		}
	})

	t.Run("appends after existing content with one blank line", func(t *testing.T) {
		orig := "resource \"aws_other\" \"keep\" {\n  size = 1\n}\n"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreCreateOp()},
			params:   coveditcoreCreateParams,
			envFiles: map[string]string{"cov.tf": orig},
		})
		coveditcoreWantExit(t, got, 0)
		b, err := os.ReadFile(filepath.Join(got.envDir, "cov.tf"))
		if err != nil {
			t.Fatal(err)
		}
		want := orig + "\n" + coveditcoreCreated
		if string(b) != want {
			t.Fatalf("appended file =\n%q\nwant\n%q", b, want)
		}
	})

	t.Run("dry-run writes no service file", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreCreateOp()},
			params: coveditcoreCreateParams,
			dryRun: true,
		})
		coveditcoreWantExit(t, got, 0)
		if _, err := os.Stat(filepath.Join(got.envDir, "cov.tf")); !os.IsNotExist(err) {
			t.Fatalf("cov.tf exists after --dry-run (stat err %v)", err)
		}
		if !strings.Contains(got.stdout, "+resource \"aws_coveditcore_thing\" \"finance_interface\" {") {
			t.Fatalf("diff = %q, want the authored resource line", got.stdout)
		}
	})

	t.Run("--diff-out mirrors the create diff", func(t *testing.T) {
		out := filepath.Join(t.TempDir(), "create.diff")
		got := coveditcoreRun(t, coveditcoreCase{
			ops:     []manifests.Op{coveditcoreCreateOp()},
			params:  coveditcoreCreateParams,
			dryRun:  true,
			diffOut: out,
		})
		coveditcoreWantExit(t, got, 0)
		b, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != got.stdout {
			t.Fatalf("--diff-out =\n%q\nstdout =\n%q", b, got.stdout)
		}
	})
}

// TestCoveditcoreRunCreateLaneRefuses: every create gate that returns a (code,
// reason) is an exit-2 REFUSE that writes nothing.
func TestCoveditcoreRunCreateLaneRefuses(t *testing.T) {
	t.Run("an existing idiom address refuses ALREADY_EXISTS", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreCreateOp()},
			params: coveditcoreCreateParams,
			envFiles: map[string]string{
				"existing.tf": "resource \"aws_coveditcore_thing\" \"finance_interface\" {\n}\n",
			},
		})
		coveditcoreWantRefusal(t, got, "ALREADY_EXISTS")
		coveditcoreWantStderr(t, got, "aws_coveditcore_thing.finance_interface already exists")
		if _, err := os.Stat(filepath.Join(got.envDir, "cov.tf")); !os.IsNotExist(err) {
			t.Fatalf("cov.tf written despite ALREADY_EXISTS (stat err %v)", err)
		}
	})

	t.Run("a fmt-dirty service file refuses FMT_DIRTY", func(t *testing.T) {
		dirty := "resource \"aws_other\" \"keep\" {\n      size =    1\n}\n"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{coveditcoreCreateOp()},
			params:   coveditcoreCreateParams,
			envFiles: map[string]string{"cov.tf": dirty},
		})
		coveditcoreWantRefusal(t, got, "FMT_DIRTY")
		coveditcoreWantStderr(t, got, "cov.tf is not fmt-canonical")
		b, _ := os.ReadFile(filepath.Join(got.envDir, "cov.tf"))
		if string(b) != dirty {
			t.Fatalf("file changed on a FMT_DIRTY refusal: %q", b)
		}
	})

	t.Run("a non-provider resource type refuses MALFORMED_CREATE_LABEL", func(t *testing.T) {
		op := coveditcoreCreateOp()
		op.Target.ResourceType = "gcp_storage_bucket" // not aws_*/azurerm_*
		got := coveditcoreRun(t, coveditcoreCase{ops: []manifests.Op{op}, params: coveditcoreCreateParams})
		coveditcoreWantRefusal(t, got, "MALFORMED_CREATE_LABEL")
		coveditcoreWantStderr(t, got, `"gcp_storage_bucket"`)
	})

	t.Run("an undeclared nested block refuses UNKNOWN_BLOCK_TYPE", func(t *testing.T) {
		op := coveditcoreCreateOp()
		op.Params[1].Path = []string{"bad_block"} // the dump declares only good_block
		got := coveditcoreRun(t, coveditcoreCase{ops: []manifests.Op{op}, params: coveditcoreCreateParams})
		coveditcoreWantRefusal(t, got, RefuseUnknownBlockType)
		coveditcoreWantStderr(t, got, `declares no nested block "bad_block"`)
	})

	t.Run("a cross-type co-emitted reference refuses REFERENCE_TYPE_MISMATCH", func(t *testing.T) {
		op := coveditcoreCreateOp()
		op.Params = append(op.Params, manifests.Param{
			Name: "kms", Source: "inventory", Role: "reference", RefAttr: "arn",
			EnumSource: "inventory://aws_kms_key/arn",
		})
		params := map[string]any{"name": "Finance Interface", "size": 10, "kms": "aws_iam_role.wrong"}
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   params,
			envFiles: map[string]string{"refs.tf": "resource \"aws_iam_role\" \"wrong\" {\n}\n"},
		})
		coveditcoreWantRefusal(t, got, "REFERENCE_TYPE_MISMATCH")
	})
}

// TestCoveditcoreRunCreateLaneErrors: the create branch's non-refusal failures —
// a resolution failure is exit 3, everything else exit 1.
func TestCoveditcoreRunCreateLaneErrors(t *testing.T) {
	t.Run("unreadable --schema exits 3", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreCreateOp()},
			params: coveditcoreCreateParams,
			schema: filepath.Join(t.TempDir(), "absent-schema.json"),
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, "schema: ")
	})

	t.Run("an unresolvable co-emitted reference exits 3", func(t *testing.T) {
		op := coveditcoreCreateOp()
		op.Params = append(op.Params, manifests.Param{
			Name: "kms", Source: "inventory", Role: "reference", RefAttr: "arn",
		})
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{op},
			params: map[string]any{"name": "Finance Interface", "size": 10, "kms": "aws_kms_key.absent"},
		})
		coveditcoreWantExit(t, got, 3)
		coveditcoreWantStderr(t, got, `address "aws_kms_key.absent" not found`)
	})

	t.Run("an op with no service exits 1", func(t *testing.T) {
		op := coveditcoreCreateOp()
		op.Service = ""
		got := coveditcoreRun(t, coveditcoreCase{ops: []manifests.Op{op}, params: coveditcoreCreateParams})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "has no service to target a file")
	})

	t.Run("an unreadable service file exits 1", func(t *testing.T) {
		env := t.TempDir()
		if err := os.Mkdir(filepath.Join(env, "cov.tf"), 0o755); err != nil {
			t.Fatal(err)
		}
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreCreateOp()},
			params: coveditcoreCreateParams,
			envDir: env,
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "is a directory")
	})

	t.Run("an env dir that does not exist fails the atomic write with exit 1", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreCreateOp()},
			params: coveditcoreCreateParams,
			envDir: filepath.Join(t.TempDir(), "no-such-env"),
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "no such file or directory")
	})

	t.Run("failing stdout exits 1", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{coveditcoreCreateOp()},
			params: coveditcoreCreateParams,
			dryRun: true,
			stdout: coveditcoreFailWriter{},
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "coveditcore: stdout is closed")
	})

	t.Run("unwritable --diff-out exits 1", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:     []manifests.Op{coveditcoreCreateOp()},
			params:  coveditcoreCreateParams,
			dryRun:  true,
			diffOut: filepath.Join(t.TempDir(), "no-such-dir", "create.diff"),
		})
		coveditcoreWantExit(t, got, 1)
		coveditcoreWantStderr(t, got, "no such file or directory")
	})
}

// ── create.go: the pure helpers ──────────────────────────────────────────────

// TestCoveditcoreSkeletonAppend pins the "one blank line before the appended
// block" rule for all three shapes of the pre-existing file.
func TestCoveditcoreSkeletonAppend(t *testing.T) {
	tests := []struct {
		name string
		orig string
		want string
	}{
		{name: "brand-new file gets no leading blank", orig: "", want: "resource {}\n"},
		{
			name: "newline-terminated orig gets one blank line",
			orig: "resource \"a\" \"b\" {\n}\n",
			want: "\nresource {}\n",
		},
		{
			name: "orig without a trailing newline gets its line finished first",
			orig: "resource \"a\" \"b\" {\n}",
			want: "\n\nresource {}\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := string(skeletonAppend([]byte(tt.orig), "resource {}"))
			if got != tt.want {
				t.Fatalf("skeletonAppend = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestCoveditcoreRefElements: a list reference yields its members, a scalar yields
// itself — so a list is validated element-by-element, never as one opaque value.
func TestCoveditcoreRefElements(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want []any
	}{
		{name: "list yields its members", raw: []any{"aws_subnet.a", "aws_subnet.b"}, want: []any{"aws_subnet.a", "aws_subnet.b"}},
		{name: "empty list yields nothing", raw: []any{}, want: []any{}},
		{name: "scalar string yields itself", raw: "aws_kms_key.k", want: []any{"aws_kms_key.k"}},
		{name: "nil yields one nil element", raw: nil, want: []any{nil}},
		{name: "number yields itself", raw: 7, want: []any{7}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := refElements(tt.raw)
			if len(got) != len(tt.want) {
				t.Fatalf("refElements(%#v) = %#v, want %#v", tt.raw, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("refElements(%#v)[%d] = %#v, want %#v", tt.raw, i, got[i], tt.want[i])
				}
			}
		})
	}
}

// TestCoveditcoreValidateCreateReferences: only ACTIVE, non-empty role:"reference"
// params reach the shared value seam — matching the renderer's omit-if-absent
// behaviour so an omitted optional reference never causes a spurious refusal —
// and the ones that do reach it carry the full guard set (cross-type refusal,
// existence/uniqueness resolution error), element by element for a list.
func TestCoveditcoreValidateCreateReferences(t *testing.T) {
	env := t.TempDir()
	coveditcoreWriteFile(t, env, "refs.tf",
		"resource \"aws_coveditcore_thing\" \"present\" {\n}\n"+
			"\nresource \"aws_iam_role\" \"role\" {\n}\n")

	ref := func(mut func(*manifests.Param)) manifests.Param {
		p := manifests.Param{Name: "ref", Source: "inventory", Role: "reference", RefAttr: "id"}
		if mut != nil {
			mut(&p)
		}
		return p
	}

	tests := []struct {
		name       string
		param      manifests.Param
		params     map[string]any
		wantCode   string
		wantErrSub string
	}{
		{
			name:   "a non-reference param is never validated",
			param:  manifests.Param{Name: "ref", Source: "user_input", Type: "string"},
			params: map[string]any{"ref": "aws_coveditcore_thing.absent"},
		},
		{
			name:   "an inactive reference is skipped",
			param:  ref(func(p *manifests.Param) { p.DependsOn = json.RawMessage(`{"param":"mode","equals":"vpc"}`) }),
			params: map[string]any{"mode": "none", "ref": "aws_coveditcore_thing.absent"},
		},
		{
			name:   "an absent value is skipped",
			param:  ref(nil),
			params: map[string]any{},
		},
		{
			name:   "an empty value is skipped",
			param:  ref(nil),
			params: map[string]any{"ref": ""},
		},
		{
			name:   "an empty list element is skipped",
			param:  ref(nil),
			params: map[string]any{"ref": []any{"", "aws_coveditcore_thing.present"}},
		},
		{
			name:   "a resolvable scalar reference passes",
			param:  ref(nil),
			params: map[string]any{"ref": "aws_coveditcore_thing.present"},
		},
		{
			name:       "an unresolvable list element is a resolution error",
			param:      ref(nil),
			params:     map[string]any{"ref": []any{"", "aws_coveditcore_thing.absent"}},
			wantErrSub: `address "aws_coveditcore_thing.absent" not found`,
		},
		{
			name:     "a cross-type reference refuses",
			param:    ref(func(p *manifests.Param) { p.EnumSource = "inventory://aws_coveditcore_thing/id" }),
			params:   map[string]any{"ref": "aws_iam_role.role"},
			wantCode: "REFERENCE_TYPE_MISMATCH",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op := coveditcoreOp("cov-create", "create_resource", "aws_coveditcore_thing", tt.param)
			code, reason, err := validateCreateReferences(op, &request.Request{Params: tt.params}, env)
			if tt.wantErrSub != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErrSub) {
					t.Fatalf("err = %v, want it to contain %q", err, tt.wantErrSub)
				}
				if !errors.Is(err, errResolution) {
					t.Fatalf("err = %v, want it wrapped in errResolution (exit 3)", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err = %v", err)
			}
			if code != tt.wantCode {
				t.Fatalf("code = %q (%s), want %q", code, reason, tt.wantCode)
			}
		})
	}
}

// ── createsupport.go ─────────────────────────────────────────────────────────

// TestCoveditcoreParamDefault: the manifest default decodes into the Go value the
// renderer falls back to; an absent, null or undecodable default is nil, so a
// malformed manifest can never inject a half-decoded value.
func TestCoveditcoreParamDefault(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want any
	}{
		{name: "absent default is nil", raw: "", want: nil},
		{name: "explicit null is nil", raw: "null", want: nil},
		{name: "undecodable default is nil", raw: "{not json", want: nil},
		{name: "string default decodes", raw: `"gp3"`, want: "gp3"},
		{name: "number default decodes as float64", raw: "365", want: float64(365)},
		{name: "bool default decodes", raw: "true", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := manifests.Param{Name: "p"}
			if tt.raw != "" {
				p.Default = json.RawMessage(tt.raw)
			}
			if got := paramDefault(p); got != tt.want {
				t.Fatalf("paramDefault(%q) = %#v, want %#v", tt.raw, got, tt.want)
			}
		})
	}

	// The seam paramValue depends on: an omitted non-required param falls back to
	// the manifest default rather than reaching the value layer as nil.
	p := manifests.Param{Name: "target_type", Default: json.RawMessage(`"gp3"`)}
	if got := paramValue(p, map[string]any{}); got != "gp3" {
		t.Fatalf("paramValue with an omitted value = %#v, want the default %q", got, "gp3")
	}
	if got := paramValue(p, map[string]any{"target_type": "io2"}); got != "io2" {
		t.Fatalf("paramValue = %#v, want the submitted value %q", got, "io2")
	}
}

// TestCoveditcoreToNumber mirrors the JS Number(value) contract the renderer's
// `Number.isFinite(n)` guard depends on: numeric Go types and numeric strings
// coerce; anything else is not-a-number so the caller falls back to a string
// literal instead of emitting a bare token.
func TestCoveditcoreToNumber(t *testing.T) {
	tests := []struct {
		name   string
		in     any
		want   float64
		wantOk bool
	}{
		{name: "float64", in: float64(1.5), want: 1.5, wantOk: true},
		{name: "float32", in: float32(2.5), want: 2.5, wantOk: true},
		{name: "int", in: 100, want: 100, wantOk: true},
		{name: "int64", in: int64(365), want: 365, wantOk: true},
		{name: "json.Number", in: json.Number("42"), want: 42, wantOk: true},
		{name: "unparseable json.Number", in: json.Number("not-a-number"), want: 0, wantOk: false},
		{name: "numeric string", in: "7", want: 7, wantOk: true},
		{name: "non-numeric string", in: "gp3", want: 0, wantOk: false},
		{name: "bool is not a number", in: true, want: 0, wantOk: false},
		{name: "nil is not a number", in: nil, want: 0, wantOk: false},
		{name: "list is not a number", in: []any{1}, want: 0, wantOk: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := toNumber(tt.in)
			if ok != tt.wantOk || got != tt.want {
				t.Fatalf("toNumber(%#v) = (%v, %v), want (%v, %v)", tt.in, got, ok, tt.want, tt.wantOk)
			}
		})
	}
}

// ── instantiate.go ───────────────────────────────────────────────────────────

// TestCoveditcoreInstantiateName: the proposed module name is the FIRST
// non-inventory param carrying a string; anything else yields "" (so the address
// degrades to "module." and the verb still refuses, never guesses a name).
func TestCoveditcoreInstantiateName(t *testing.T) {
	tests := []struct {
		name   string
		params []manifests.Param
		values map[string]any
		want   string
	}{
		{
			name:   "no params at all",
			params: nil,
			values: map[string]any{},
			want:   "",
		},
		{
			name:   "only an inventory param",
			params: []manifests.Param{coveditcoreTarget},
			values: map[string]any{"target": "aws_ebs_volume.v"},
			want:   "",
		},
		{
			name:   "a non-string value is not a name",
			params: []manifests.Param{{Name: "module_name", Source: "user_input"}},
			values: map[string]any{"module_name": 42},
			want:   "",
		},
		{
			name:   "a selector param is not a name",
			params: []manifests.Param{{Name: "which", Source: "user_input", Role: "selector"}},
			values: map[string]any{"which": "picked"},
			want:   "",
		},
		{
			name:   "the first user_input string wins",
			params: []manifests.Param{coveditcoreTarget, {Name: "module_name", Source: "user_input"}},
			values: map[string]any{"target": "aws_ebs_volume.v", "module_name": "vpn_route"},
			want:   "vpn_route",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op := coveditcoreOp("cov-inst", "instantiate_module", "", tt.params...)
			if got := instantiateName(op, &request.Request{Params: tt.values}); got != tt.want {
				t.Fatalf("instantiateName = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestCoveditcoreRunInstantiateLane: instantiate_module has no accept path in v1 —
// it refuses ALREADY_EXISTS when the module address is present and
// NO_MODULE_SOURCE otherwise. Either way it is exit 2 and no file is touched.
func TestCoveditcoreRunInstantiateLane(t *testing.T) {
	op := coveditcoreOp("cov-inst", "instantiate_module", "",
		manifests.Param{Name: "module_name", Source: "user_input", Type: "string"})

	t.Run("no module source refuses NO_MODULE_SOURCE", func(t *testing.T) {
		got := coveditcoreRun(t, coveditcoreCase{
			ops:    []manifests.Op{op},
			params: map[string]any{"module_name": "vpn_route"},
		})
		coveditcoreWantRefusal(t, got, "NO_MODULE_SOURCE")
		coveditcoreWantStderr(t, got, "instantiate is engineer-only in v1")
	})

	t.Run("an existing module address refuses ALREADY_EXISTS", func(t *testing.T) {
		mod := "module \"vpn_route\" {\n  source = \"./m\"\n}\n"
		got := coveditcoreRun(t, coveditcoreCase{
			ops:      []manifests.Op{op},
			params:   map[string]any{"module_name": "vpn_route"},
			envFiles: map[string]string{"main.tf": mod},
		})
		coveditcoreWantRefusal(t, got, "ALREADY_EXISTS")
		coveditcoreWantStderr(t, got, "module.vpn_route already exists")
		b, _ := os.ReadFile(filepath.Join(got.envDir, "main.tf"))
		if string(b) != mod {
			t.Fatalf("file changed on an instantiate refusal: %q", b)
		}
	})
}

// ── edit.go: the small pure seams ────────────────────────────────────────────

// TestCoveditcoreTargetAddress: the target address is the value of the FIRST
// source:"inventory" param that is not a role:"reference" (a reference names a
// different resource to read from, never the block being edited). Every failure is
// an error, never a silent "" that would locate the wrong block.
func TestCoveditcoreTargetAddress(t *testing.T) {
	reference := manifests.Param{Name: "kms", Source: "inventory", Role: "reference", RefAttr: "arn"}

	tests := []struct {
		name       string
		params     []manifests.Param
		values     map[string]any
		want       string
		wantErrSub string
	}{
		{
			name:   "the inventory param supplies the address",
			params: []manifests.Param{coveditcoreTarget},
			values: map[string]any{"target": "aws_ebs_volume.v"},
			want:   "aws_ebs_volume.v",
		},
		{
			name:   "a reference param is skipped in favour of the real target",
			params: []manifests.Param{reference, coveditcoreTarget},
			values: map[string]any{"kms": "aws_kms_key.k", "target": "aws_ebs_volume.v"},
			want:   "aws_ebs_volume.v",
		},
		{
			name:       "a reference-only op has no target",
			params:     []manifests.Param{reference},
			values:     map[string]any{"kms": "aws_kms_key.k"},
			wantErrSub: `op "cov-op" has no inventory param`,
		},
		{
			name:       "no inventory param at all",
			params:     []manifests.Param{{Name: "new_size", Source: "user_input"}},
			values:     map[string]any{"new_size": 10},
			wantErrSub: `op "cov-op" has no inventory param`,
		},
		{
			name:       "the inventory value is missing",
			params:     []manifests.Param{coveditcoreTarget},
			values:     map[string]any{},
			wantErrSub: `missing inventory param "target"`,
		},
		{
			name:       "the inventory value is not a string",
			params:     []manifests.Param{coveditcoreTarget},
			values:     map[string]any{"target": 42},
			wantErrSub: `inventory param "target" is not a string`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op := coveditcoreOp("cov-op", "set_attribute", "aws_ebs_volume", tt.params...)
			got, err := targetAddress(op, tt.values)
			if tt.wantErrSub != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErrSub) {
					t.Fatalf("err = %v, want it to contain %q", err, tt.wantErrSub)
				}
				if got != "" {
					t.Fatalf("address = %q, want \"\" alongside the error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err = %v", err)
			}
			if got != tt.want {
				t.Fatalf("address = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestCoveditcoreNeverMaskAttrsFor: the never-mask set is the LEAF attribute name
// of every role:"const"/"key" param that is not flagged sensitive — the guardrail
// values a reviewer must read unmasked in the evidence diff. A dotted attr
// contributes only its leaf; sensitive wins; ordinary value params never appear.
func TestCoveditcoreNeverMaskAttrsFor(t *testing.T) {
	tests := []struct {
		name   string
		params []manifests.Param
		want   []string
	}{
		{name: "no const or key params", params: []manifests.Param{coveditcoreTarget}, want: nil},
		{
			name:   "a const param contributes its name",
			params: []manifests.Param{{Name: "http_tokens", Role: "const", Const: "required"}},
			want:   []string{"http_tokens"},
		},
		{
			name:   "an explicit attr overrides the name",
			params: []manifests.Param{{Name: "token", Role: "key", Attr: "creation_token"}},
			want:   []string{"creation_token"},
		},
		{
			name:   "a dotted attr contributes only its leaf",
			params: []manifests.Param{{Name: "tokens", Role: "const", Attr: "metadata_options.http_tokens"}},
			want:   []string{"http_tokens"},
		},
		{
			name:   "a sensitive const stays maskable",
			params: []manifests.Param{{Name: "secret", Role: "const", Sensitive: true}},
			want:   nil,
		},
		{
			name: "manifest order is preserved",
			params: []manifests.Param{
				{Name: "http_tokens", Role: "const"},
				{Name: "plain", Source: "user_input"},
				{Name: "creation_token", Role: "key"},
			},
			want: []string{"http_tokens", "creation_token"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := neverMaskAttrsFor(coveditcoreOp("cov-op", "set_attribute", "aws_x", tt.params...))
			if len(got) != len(tt.want) {
				t.Fatalf("neverMaskAttrsFor = %#v, want %#v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("neverMaskAttrsFor = %#v, want %#v", got, tt.want)
				}
			}
		})
	}
}

// TestCoveditcoreParseSingleBlock: the located bytes must reparse to EXACTLY one
// block. Zero, several, or unparseable bytes are internal errors (exit 1) — the
// verbs must never edit an ambiguous tree.
func TestCoveditcoreParseSingleBlock(t *testing.T) {
	t.Run("one block reparses", func(t *testing.T) {
		src := []byte(coveditcoreVolume)
		loc := &hclops.Located{File: "main.tf", Bytes: src, Start: 0, End: len(src)}
		f, blk, err := parseSingleBlock(loc)
		if err != nil {
			t.Fatalf("unexpected err = %v", err)
		}
		if f == nil || blk == nil {
			t.Fatal("parseSingleBlock returned nil file/block without an error")
		}
		if blk.Type() != "resource" {
			t.Fatalf("block type = %q, want \"resource\"", blk.Type())
		}
		if got := blk.Labels(); len(got) != 2 || got[0] != "aws_ebs_volume" || got[1] != "v" {
			t.Fatalf("labels = %#v, want [aws_ebs_volume v]", got)
		}
	})

	bad := []struct {
		name    string
		src     string
		wantSub string
	}{
		{name: "unparseable bytes", src: "a = = 1\n", wantSub: "parse block"},
		{name: "no block at all", src: "size = 1\n", wantSub: "expected exactly one block, got 0"},
		{name: "two blocks", src: coveditcoreVolume + coveditcoreVolume, wantSub: "expected exactly one block, got 2"},
	}
	for _, tt := range bad {
		t.Run(tt.name, func(t *testing.T) {
			src := []byte(tt.src)
			loc := &hclops.Located{File: "main.tf", Bytes: src, Start: 0, End: len(src)}
			f, blk, err := parseSingleBlock(loc)
			if err == nil {
				t.Fatalf("want an error, got file=%v block=%v", f, blk)
			}
			if f != nil || blk != nil {
				t.Fatalf("want nil file/block on error, got %v / %v", f, blk)
			}
			if !strings.Contains(err.Error(), tt.wantSub) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.wantSub)
			}
		})
	}
}

// TestCoveditcoreAtomicWrite: the write is temp-file + rename, so the target is
// either the old bytes or the new bytes and no partial file or temp remnant is
// ever left behind. A directory that does not exist is an error, not a partial write.
func TestCoveditcoreAtomicWrite(t *testing.T) {
	t.Run("creates the file and leaves no temp behind", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "main.tf")
		if err := atomicWrite(path, []byte("new\n")); err != nil {
			t.Fatalf("atomicWrite: %v", err)
		}
		b, err := os.ReadFile(path)
		if err != nil || string(b) != "new\n" {
			t.Fatalf("file = %q (err %v), want %q", b, err, "new\n")
		}
		entries, _ := os.ReadDir(dir)
		if len(entries) != 1 {
			t.Fatalf("dir holds %d entries, want only the written file", len(entries))
		}
	})

	t.Run("replaces existing content", func(t *testing.T) {
		dir := t.TempDir()
		path := coveditcoreWriteFile(t, dir, "main.tf", "old bytes\n")
		if err := atomicWrite(path, []byte("replaced\n")); err != nil {
			t.Fatalf("atomicWrite: %v", err)
		}
		b, _ := os.ReadFile(path)
		if string(b) != "replaced\n" {
			t.Fatalf("file = %q, want %q", b, "replaced\n")
		}
	})

	t.Run("a directory that does not exist is an error", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "no-such-dir", "main.tf")
		err := atomicWrite(path, []byte("x"))
		if err == nil {
			t.Fatal("want an error for a missing directory")
		}
		if !strings.Contains(err.Error(), "no such file or directory") {
			t.Fatalf("err = %v, want a missing-directory error", err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Fatalf("a file was created despite the error (stat err %v)", statErr)
		}
	})
}

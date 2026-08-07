package main_test

import (
	"os"
	"regexp"
	"testing"
)

// TestReadmeSubcommandsComplete — DOC-8/ARCH-12: README.md's Subcommands table claimed to be
// "the complete list, no more, no fewer" against internal/cli/cli.go, but only listed 6 of the
// 9 real `case "..."` arms in cli.Run — drift-edit, scan-worker, and window-check were all
// missing. Extracts every case string from cli.go directly (not a hand-copied count) and fails
// if README.md's table is missing any of them, so a TENTH subcommand added later without a
// README row is caught the same way.
func TestReadmeSubcommandsComplete(t *testing.T) {
	cliSrc, err := os.ReadFile("internal/cli/cli.go")
	if err != nil {
		t.Fatal(err)
	}
	readme, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}

	caseRe := regexp.MustCompile(`(?m)^\tcase "([a-z-]+)":`)
	matches := caseRe.FindAllSubmatch(cliSrc, -1)
	if len(matches) == 0 {
		t.Fatal("found zero `case \"...\":` arms in cli.go — extraction is broken, not a clean repo")
	}

	backtickRe := func(name string) *regexp.Regexp {
		return regexp.MustCompile("`" + regexp.QuoteMeta(name) + "`")
	}
	for _, m := range matches {
		subcommand := string(m[1])
		if !backtickRe(subcommand).Match(readme) {
			t.Errorf("cli.go handles subcommand %q but README.md's Subcommands table never mentions it", subcommand)
		}
	}
}

// TestReadmeEditVerbsComplete — DOC-8: the "edit verbs (12)" list omitted `create_resource`,
// dispatched through a FOURTH table (create.go's createHandlers, the pre-locate ACCEPT branch a
// create needs since it has no existing block to locate) that edit.go's own three tables don't
// cover — 13 verbs, not 12. Extracts every verb key from all four dispatch tables directly.
func TestReadmeEditVerbsComplete(t *testing.T) {
	editSrc, err := os.ReadFile("internal/edit/edit.go")
	if err != nil {
		t.Fatal(err)
	}
	createSrc, err := os.ReadFile("internal/edit/create.go")
	if err != nil {
		t.Fatal(err)
	}
	readme, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}

	verbRe := regexp.MustCompile(`"([a-z_]+)":\s*(?:[a-zA-Z]+,|true,?)`)
	verbs := map[string]bool{}
	for _, src := range [][]byte{editSrc, createSrc} {
		for _, m := range verbRe.FindAllSubmatch(src, -1) {
			verbs[string(m[1])] = true
		}
	}
	if len(verbs) == 0 {
		t.Fatal("found zero dispatch-table verb keys — extraction is broken, not a clean repo")
	}

	backtickRe := func(name string) *regexp.Regexp {
		return regexp.MustCompile("`" + regexp.QuoteMeta(name) + "`")
	}
	for verb := range verbs {
		if !backtickRe(verb).Match(readme) {
			t.Errorf("edit.go/create.go dispatch on verb %q but README.md's edit-verbs list never mentions it", verb)
		}
	}
}

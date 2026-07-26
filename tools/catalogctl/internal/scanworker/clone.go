package scanworker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// GitCloner is the production Cloner: one `git clone` of a public repository,
// run with a stripped environment and every convenience git offers turned off.
//
// A clone is the moment a hostile repository first gets to influence this
// process, so the flags below are not tuning — each one closes a specific door:
//
//   - --depth 1 --single-branch --no-tags: fetch the tip of one branch and
//     nothing else. History is irrelevant to a static HCL scan, and not
//     fetching it is the cheapest bound on how much a repository can make the
//     worker download.
//   - --no-recurse-submodules (and submodule.recurse=false): a submodule URL is
//     attacker-controlled content that git would otherwise dial out to. This is
//     the clone's own SSRF hole, and it is closed rather than allowlisted.
//   - core.symlinks=false: symlinks in the tree materialize as plain files, so
//     a repository cannot point a path inside the checkout at something outside
//     it and have the scanner read that instead.
//   - protocol.allow=never + protocol.https.allow=always: git will speak https
//     and refuse every other transport, so a redirect or a stray reference
//     cannot downgrade to file://, ssh://, or ext:: (which executes a command).
//   - core.fsmonitor=, core.hooksPath=/dev/null: a repository ships hooks in
//     .git/hooks only when it is not a fresh clone, but pinning these makes it
//     structurally impossible for a config-driven hook to be picked up.
//   - credential.helper= + core.askPass= + GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS:
//     never prompt, never consult a credential store. A private repository must
//     fail loudly here rather than quietly authenticate with whatever ambient
//     credential the host happens to have.
//
// The environment is REBUILT, not inherited: the worker's own scanner key and
// anything else in its environment must not be visible to git or to anything
// git might run. HOME and XDG_CONFIG_HOME point at the throwaway workspace and
// GIT_CONFIG_NOSYSTEM=1 drops /etc/gitconfig, so no user or system config can
// re-enable any of the above.
type GitCloner struct {
	// Git is the binary to run; empty ⇒ "git". Tests point it elsewhere.
	Git string
}

// cloneArgs is the exact argv, factored out so a test can assert the hardening
// flags are present without running git — the flags ARE the security property,
// and an argv assertion is how they stay present through future edits.
func cloneArgs(cloneURL, dest string) []string {
	return []string{
		"-c", "protocol.allow=never",
		"-c", "protocol.https.allow=always",
		"-c", "credential.helper=",
		"-c", "core.askPass=",
		"-c", "core.symlinks=false",
		"-c", "core.hooksPath=/dev/null",
		"-c", "submodule.recurse=false",
		"clone",
		"--depth", "1",
		"--single-branch",
		"--no-tags",
		"--no-recurse-submodules",
		"--quiet",
		"--", cloneURL, dest,
	}
}

// cloneEnv is the complete environment git runs with — an allowlist, not a
// filter. Nothing from the worker's own environment is inherited, so the
// scanner key and the job's onboarding token are invisible to the clone.
//
// A private repo's credential rides HERE, not in argv and not in the URL:
//
//   - Not in the URL, because git writes the remote URL into `.git/config` and
//     echoes it in error messages, so a credential embedded there outlives the
//     clone and leaks into the failure text the operator reads.
//   - Not in argv (`-c http.extraHeader=...`), because argv is world-readable
//     through `ps` for the lifetime of the process.
//
// `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` is git's own env-based config, so the
// header reaches git without either exposure. The key is scoped to the exact
// clone URL, so the header cannot be replayed to some other host if git ever
// followed a redirect off it.
func cloneEnv(home, cloneURL, authHeader string) []string {
	env := []string{
		// A minimal PATH: git needs to find its own helpers.
		"PATH=" + defaultPath(),
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + home,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=/bin/false",
		"SSH_ASKPASS=/bin/false",
		// Deterministic, locale-independent messages — the failure text is
		// reported back to the operator.
		"LC_ALL=C",
	}
	if authHeader != "" {
		env = append(env,
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=http."+cloneURL+".extraHeader",
			"GIT_CONFIG_VALUE_0=Authorization: "+authHeader,
		)
	}
	return env
}

func defaultPath() string {
	if p := os.Getenv("PATH"); p != "" {
		return p
	}
	return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

// Clone implements Cloner. `authHeader` is empty for a public repository.
func (g GitCloner) Clone(ctx context.Context, cloneURL, dest, authHeader string) error {
	bin := g.Git
	if bin == "" {
		bin = "git"
	}
	// The clone's HOME is the workspace ABOVE the checkout, so a repository
	// cannot ship a `.gitconfig` at its own root and have git read it.
	home, err := os.MkdirTemp("", "ccp-scan-home-")
	if err != nil {
		return fmt.Errorf("workspace: %w", err)
	}
	defer os.RemoveAll(home)

	cmd := exec.CommandContext(ctx, bin, cloneArgs(cloneURL, dest)...)
	cmd.Env = cloneEnv(home, cloneURL, authHeader)
	cmd.Dir = home
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("timed out")
		}
		// git's own stderr, bounded — it is untrusted text that the server will
		// sanitize again before storing, but keep it short here regardless.
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if msg == "" {
			return err
		}
		return fmt.Errorf("%v: %s", err, msg)
	}
	return nil
}

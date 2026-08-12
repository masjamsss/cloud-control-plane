package hclops

import (
	"fmt"
	"os"
	"path/filepath"
)

// AtomicWrite writes data to path via a temp file + rename in path's own
// directory (spec: never a partial edit). Was internal/edit's own unexported
// atomicWrite; CTL-5 found a second, disk-writing entrypoint
// (internal/driftpropose's ApplyAdopt/appendImportBlock) using a bare
// os.WriteFile instead — the exact "a crash/ENOSPC mid-write leaves a
// truncated .tf" gap this function exists to close. Sharing one implementation
// here means the SECOND writer never has to remember to reimplement it (or
// silently drift from it — the CTL-10 class of defect this audit keeps
// finding).
//
// CTL-8: os.CreateTemp always creates 0600, and the rename then replaces a
// (typically 0644) file with it — an observable property callers promise to
// touch only inside the located block's byte range, silently changed. The
// temp file is chmod'd to the EDITED file's existing mode before rename
// (0644 for a file that doesn't exist yet, matching every tool in this
// toolchain that creates a fresh .tf). Also fsyncs the temp file before close
// — the rename is atomic against a process kill regardless, but without this
// the bytes it swaps in are not guaranteed durable against power loss.
func AtomicWrite(path string, data []byte) error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
		if info.Mode().IsRegular() {
			// path resolves (directly, or by following a symlink) to an existing
			// regular file: confirm it is actually writable before touching
			// anything. The os.Rename below only requires write permission on
			// path's own CONTAINING DIRECTORY — never on the file it replaces —
			// so without this explicit probe a read-only file would be silently
			// swapped out from under its own permission bits instead of
			// refusing the write the way this function's direct os.WriteFile
			// predecessor did. Caught by CI (which runs this repo's tests as a
			// non-root user); invisible to a root-run local `go test`, since
			// root bypasses the permission check being probed here — see
			// TestCovadoptApplyAdoptSurfacesWriteFailure's own t.Skip guard.
			probe, err := os.OpenFile(path, os.O_WRONLY, 0)
			if err != nil {
				return fmt.Errorf("%s: refusing to overwrite (not writable): %w", path, err)
			}
			probe.Close()
		}
	}
	// A path that resolves to NOTHING (the os.Stat above failed) — nothing
	// there yet, or a dangling symlink pointing into a directory that doesn't
	// exist — skips the writability probe entirely and falls through to the
	// rename-replaces behavior CTL-5 added on purpose: the temp file below
	// gets renamed over whatever sits at path (file or symlink) rather than
	// traversing it. See
	// TestCovdriftedDriftEditImportThroughDanglingSymlinkSucceeds.
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".catalogctl-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, path)
}

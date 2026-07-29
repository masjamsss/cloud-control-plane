import { spawn } from 'node:child_process';

/**
 * Run a child process WITHOUT blocking the event loop.
 *
 * The armed lanes — bundle apply, drift generation, drift check — all shell out. They
 * used `spawnSync`, which stops the single-threaded API dead for as long as the child
 * runs: up to the 15-minute bundle timeout. Nothing else was served in that window, and
 * that includes `/readyz`, so the container's own healthcheck could fail and restart the
 * server in the middle of an apply. Findings API-1, CONC-5, OPS-3, PERF-2 and ERR-1 are
 * five views of this one behaviour.
 *
 * The contract deliberately mirrors what `spawnSync` callers already expected — a status
 * and the combined output — so the call sites change shape, not semantics:
 *
 *   - a non-zero exit, a signal, or a spawn error all resolve to a non-zero `status`
 *     rather than rejecting. Callers already treated "did not exit 0" as the failure
 *     condition, and the reason belongs in the audit detail, not in an exception;
 *   - `timeout` kills the child and resolves non-zero, the same observable outcome
 *     `spawnSync`'s `timeout` produced;
 *   - stdout and stderr are captured in arrival order into one string, matching the
 *     `${stdout}${stderr}` concatenation the call sites did by hand.
 *
 * It never rejects. A rejecting exec would turn an operator's failed command into an
 * unhandled rejection on a path that is supposed to record the failure as evidence.
 */
export interface ExecResult {
  status: number;
  out: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function execCapture(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        // No shell: the caller passes `bash -lc <cmd>` explicitly where a shell is
        // wanted, exactly as the spawnSync call sites did. Turning shell on here would
        // silently re-interpret every argv the other callers pass.
        shell: false,
      });
    } catch (e) {
      // spawn can throw synchronously (e.g. EACCES on the binary). Same shape as a
      // failed run, so the caller's one failure path covers it.
      return resolve({ status: 1, out: `spawn failed: ${(e as Error).message}` });
    }

    let out = '';
    let settled = false;
    const finish = (status: number, extra?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, out: extra ? `${out}${out ? '\n' : ''}${extra}` : out });
    };

    const timer: NodeJS.Timeout | undefined = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          finish(124, `timed out after ${opts.timeoutMs}ms`);
        }, opts.timeoutMs)
      : undefined;
    // A pending timer must not hold the process open on shutdown.
    timer?.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
    });
    child.stderr?.on('data', (d: string) => {
      out += d;
    });

    child.on('error', (e) => finish(1, `spawn failed: ${e.message}`));
    child.on('close', (code, signal) => {
      if (signal) return finish(128, `killed by ${signal}`);
      finish(code ?? 1);
    });
  });
}

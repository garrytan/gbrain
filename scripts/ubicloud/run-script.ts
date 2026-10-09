/**
 * scripts/ubicloud/run-script.ts — how scripts/ci-ubicloud.ts runs one
 * ubi-runner.sh subcommand.
 *
 * Two invariants the gate depends on:
 * - With `out` and `stdoutOnly`, only stdout reaches the file. `pack` streams
 *   a tarball to stdout, so a git warning on stderr written to the same file
 *   corrupts the archive every VM unpacks; its stderr is returned instead.
 * - A child that exits before reading all of `input` (a failed `ssh` during
 *   `unpack`) closes its stdin. The resulting EPIPE is that child's failure,
 *   reported by its exit code; it must never surface as an uncaught error that
 *   kills the orchestrator before it tears its VMs down.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";

export interface RunScriptOpts {
  /** Write output here instead of returning it (stdout and stderr, unless `stdoutOnly`). */
  out?: string;
  /** With `out`: send only stdout to the file and return stderr. */
  stdoutOnly?: boolean;
  /** File streamed to the child's stdin. */
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  /** Called with the spawned child (the orchestrator tracks children for teardown). */
  onSpawn?: (child: ChildProcess) => void;
  onClose?: (child: ChildProcess) => void;
}

export function runScript(script: string, args: string[], opts: RunScriptOpts = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", [script, ...args], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    opts.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    const sink = opts.out ? createWriteStream(opts.out) : null;
    child.stdout!.on("data", (chunk) => (sink ? sink.write(chunk) : (stdout += chunk)));
    child.stderr!.on("data", (chunk) => (sink && !opts.stdoutOnly ? sink.write(chunk) : (stderr += chunk)));
    child.stdin!.on("error", () => {});
    if (opts.input) {
      const source = createReadStream(opts.input);
      source.on("error", () => child.stdin!.destroy());
      source.pipe(child.stdin!);
    } else {
      child.stdin!.end();
    }
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.onClose?.(child);
      const text = sink ? (opts.stdoutOnly ? stderr : "") : stdout + (code ? stderr : "");
      const finish = () => resolvePromise({ code: code ?? 1, stdout: text });
      if (sink) sink.end(finish);
      else finish();
    });
  });
}

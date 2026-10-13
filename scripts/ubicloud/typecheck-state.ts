/**
 * scripts/ubicloud/typecheck-state.ts — the incremental typecheck state the
 * gate hands to the VM that runs verify.
 *
 * `bun run typecheck` is `tsc --incremental` against a buildinfo under
 * node_modules/.cache, which the checkout tarball never carries, so every gate
 * VM typechecked cold: ~81 s on a 16-vCPU VM with nothing else running, and
 * 123-126 s, past verify's 120 s per-check cap, beside verify's own pool on a
 * loaded host. The orchestrator builds the buildinfo locally while the VMs
 * boot (68 s cold on a 4-core runner, ~17 s warm) and uploads it before
 * verify. tsc rereads every file and compares content hashes, so a stale or
 * foreign buildinfo costs time, never correctness; type errors are recorded
 * in it and reported again on the VM.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The buildinfo path `bun run typecheck` writes, relative to the checkout, or null when it writes none. */
export function typecheckBuildInfo(root: string): string | null {
  try {
    const script = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.typecheck;
    return script?.match(/--tsBuildInfoFile\s+(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Run `bun run typecheck` in `root`, output to `logPath`; resolves with its exit code and duration. */
export function buildTypecheckState(root: string, logPath: string, onSpawn: (child: ChildProcess) => void): Promise<{ code: number; ms: number }> {
  const started = Date.now();
  const fd = openSync(logPath, "w");
  const child = spawn(process.execPath, ["run", "typecheck"], { cwd: root, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  onSpawn(child);
  return new Promise((done) => {
    child.once("error", () => done({ code: 127, ms: Date.now() - started }));
    child.once("close", (code) => done({ code: code ?? 1, ms: Date.now() - started }));
  });
}

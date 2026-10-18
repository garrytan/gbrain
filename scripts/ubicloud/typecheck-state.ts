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
 *
 * tsc records each file relative to the buildinfo's directory, but reaches
 * node_modules files (the lib files, bun-types' globals) through their real
 * path. In a worktree whose node_modules is a symlink to another checkout's,
 * those entries climb out of the checkout ("../../../../../../../../workspace/
 * gbrain/node_modules/typescript/lib/lib.es5.d.ts"), resolve to nothing on the
 * VM, and the changed globals make tsc recheck every file: the upload ran cold
 * (84-121 s) while the log said warm (#6673). `portableBuildInfo` re-roots
 * those entries under the checkout's own node_modules path, which the VM's
 * frozen install has in the same layout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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

/**
 * Write `root`'s buildinfo to `out` with every entry reached through a
 * symlinked node_modules re-rooted under `root/node_modules`. Returns how many
 * entries moved and how many still resolve outside `root` (those would be
 * rechecked from scratch on the VM), or null when the file is not a buildinfo.
 */
export function portableBuildInfo(root: string, buildInfo: string, out: string): { moved: number; outside: number } | null {
  const path = join(root, buildInfo);
  const info = JSON.parse(readFileSync(path, "utf8")) as { fileNames?: unknown };
  if (!Array.isArray(info.fileNames)) return null;
  const base = dirname(path), modules = join(root, "node_modules");
  const real = realpathSync(modules);
  let moved = 0, outside = 0;
  info.fileNames = info.fileNames.map((name: string) => {
    let file = resolve(base, name);
    if (real !== modules && file.startsWith(real + sep)) {
      file = modules + file.slice(real.length);
      moved++;
    }
    if (!file.startsWith(root + sep)) outside++;
    return relative(base, file).split(sep).join("/");
  });
  writeFileSync(out, JSON.stringify(info));
  return { moved, outside };
}

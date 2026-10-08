// ubicloud-run-script.test.ts — scripts/ubicloud/run-script.ts, the way
// scripts/ci-ubicloud.ts runs every ubi-runner.sh subcommand.
//
// Protects: with `stdoutOnly`, a script's stderr never lands in the `out`
// file (the gate's checkout tarball was corrupted by a git warning written
// into it), and a child that exits before reading its `input` (a failed
// `ssh` during `unpack`) resolves with its exit code instead of an uncaught
// EPIPE that killed the orchestrator before it tore its VMs down.
// Each case runs in its own Bun process, so an uncaught error shows up as a
// crashed child rather than taking this test runner down.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HELPER = resolve(import.meta.dir, "..", "..", "scripts/ubicloud/run-script.ts");
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ubicloud-run-script-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function drive(script: string, opts: Record<string, unknown>) {
  const scriptPath = join(dir, "script.sh");
  writeFileSync(scriptPath, script);
  const driver = join(dir, "driver.ts");
  writeFileSync(driver, `import { runScript } from ${JSON.stringify(HELPER)};
const r = await runScript(${JSON.stringify(scriptPath)}, [], ${JSON.stringify(opts)});
console.log(JSON.stringify(r));
`);
  const proc = Bun.spawn(["bun", driver], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr, result: code === 0 ? JSON.parse(stdout.trim().split("\n").at(-1)!) as { code: number; stdout: string } : null };
}

describe("runScript", () => {
  it("stdoutOnly: the out file holds stdout alone; stderr comes back in the result", async () => {
    const out = join(dir, "archive.bin");
    const run = await drive("printf 'ARCHIVE'\necho 'fatal: a git warning' >&2\n", { out, stdoutOnly: true });
    expect(run.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("ARCHIVE");
    expect(run.result).toEqual({ code: 0, stdout: "fatal: a git warning\n" });
  });

  it("a child that exits before reading all its input resolves with its exit code (no uncaught EPIPE)", async () => {
    const input = join(dir, "big.bin");
    writeFileSync(input, Buffer.alloc(32 * 1024 * 1024, 1));
    const run = await drive("head -c 1 >/dev/null; sleep 0.2; exit 3\n", { input, out: join(dir, "log.txt") });
    expect({ code: run.code, crashed: /EPIPE/.test(run.stderr) }).toEqual({ code: 0, crashed: false });
    expect(run.result?.code).toBe(3);
  });
});

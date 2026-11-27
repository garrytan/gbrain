// ubi-runner-api-key-argv.test.ts — scripts/ubicloud/ubi-runner.sh keeps the
// Ubicloud API key out of curl's argv (org rule R60: a key in a process's
// arguments shows up in any process listing).
//
// Protects: `api` hands curl the Authorization header as a file on a pipe
// (`-H @<(printf ...)`), and the real API still receives `Bearer <key>`.
// Fails when: the key appears in curl's command line, or the header stops
// reaching the server.
// Network: none (a stub curl on PATH, then an in-process HTTP server).

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RUNNER = resolve(import.meta.dir, "..", "..", "scripts/ubicloud/ubi-runner.sh");

test("the API key reaches curl as a header file, never in its argv, and the API still gets Bearer <key>", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubi-api-key-"));
  const key = "test-ubi-key-4711";
  try {
    const bin = join(root, "bin"), argv = join(root, "argv.log"), hdr = join(root, "hdr.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(argv)}
out=""; prev=""
for a in "$@"; do
  [ "$prev" = -o ] && out=$a
  [ "$prev" = -H ] && case $a in @*) cat "\${a#@}" >> ${JSON.stringify(hdr)} ;; esac
  prev=$a
done
cat >/dev/null; printf '' > "$out"; printf 200
`);
    chmodSync(join(bin, "curl"), 0o755);
    const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, UBICLOUD_API_KEY: key, UBI_RUNNER_STATE: join(root, "state") };
    const faked = Bun.spawnSync(["bash", RUNNER, "cli", "vm", "list"], { env: { ...base, PATH: `${bin}:${base.PATH}` }, timeout: 10_000 });
    expect(faked.exitCode, faked.stderr.toString()).toBe(0);
    expect(readFileSync(argv, "utf8")).toContain("--data @-");
    expect(readFileSync(argv, "utf8")).not.toContain(key);
    expect(readFileSync(hdr, "utf8")).toBe(`Authorization: Bearer ${key}\n`);

    let seen = "";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen = req.headers.get("authorization") ?? ""; return new Response("eu-central-h1 vm-a\n"); } });
    try {
      const real = Bun.spawn(["bash", RUNNER, "cli", "vm", "list"], { env: { ...base, UBICLOUD_API_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(real.stdout).text(), real.exited]);
      expect(code).toBe(0);
      expect(out).toBe("eu-central-h1 vm-a\n");
      expect(seen).toBe(`Bearer ${key}`);
    } finally {
      server.stop(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

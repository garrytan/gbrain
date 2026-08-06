import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createHtmlDocumentNormalizer,
  preflightDocumentParsers,
} from "../src/coe/evidence/index.ts";

const STDOUT_LIMIT_BYTES = 64 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;

const temporaryDirectories: string[] = [];

async function createEmitter(
  stream: "stdout" | "stderr",
  byteCount: number,
  stallAfterOutput = false,
  spawnDescendant = false,
): Promise<{
  executable: string;
  completionMarker: string;
  pidFile: string;
  descendantPidFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "gbrain-coe-parser-limit-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "emit-parser-output");
  const completionMarker = join(directory, "completed");
  const pidFile = join(directory, "pid");
  const descendantPidFile = join(directory, "descendant-pid");
  const script = `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";

await writeFile(${JSON.stringify(pidFile)}, String(process.pid));
${spawnDescendant ? `const descendant = Bun.spawn(["/bin/sh", "-c", "sleep 3"], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
await writeFile(${JSON.stringify(descendantPidFile)}, String(descendant.pid));` : ""}
const stream = process.${stream};
const chunk = Buffer.alloc(64 * 1024, 0x61);
let remaining = ${byteCount};
while (remaining > 0) {
  const bytes = Math.min(remaining, chunk.byteLength);
  if (!stream.write(chunk.subarray(0, bytes))) {
    await new Promise<void>((resolve) => stream.once("drain", resolve));
  }
  remaining -= bytes;
}
${stream === "stderr" ? `process.stdout.write(JSON.stringify({
  python: "fixture-python",
  html: { available: true, name: "fixture-html", version: "1.0.0" },
  pdf: { available: true, name: "fixture-pdf", version: "1.0.0" },
}));` : ""}
${stallAfterOutput ? "await Bun.sleep(30_000);" : ""}
await writeFile(${JSON.stringify(completionMarker)}, "completed");
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, completionMarker, pidFile, descendantPidFile };
}

async function createNormalizeOverflowEmitter(): Promise<{
  executable: string;
  completionMarker: string;
  pidFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "gbrain-coe-normalize-limit-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "emit-normalize-output");
  const completionMarker = join(directory, "completed");
  const pidFile = join(directory, "pid");
  const script = `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";

if (process.argv.includes("--preflight")) {
  process.stdout.write(JSON.stringify({
    python: "fixture-python",
    html: { available: true, name: "fixture-html", version: "1.0.0" },
    pdf: { available: true, name: "fixture-pdf", version: "1.0.0" },
  }));
  process.exit(0);
}
await writeFile(${JSON.stringify(pidFile)}, String(process.pid));
const output = Buffer.alloc(${STDERR_LIMIT_BYTES + 1}, 0x61);
process.stderr.write(output);
await Bun.sleep(30_000);
await writeFile(${JSON.stringify(completionMarker)}, "completed");
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, completionMarker, pidFile };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function processIsRunning(pidFile: string): Promise<boolean> {
  const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilStopped(pidFile: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await processIsRunning(pidFile))) return true;
    await Bun.sleep(10);
  }
  return false;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("CoE Python document-parser output limits", () => {
  test("stdout overflow terminates the parser before it can finish emitting", async () => {
    const { executable, completionMarker, pidFile } = await createEmitter(
      "stdout",
      STDOUT_LIMIT_BYTES + 1,
      true,
    );
    const startedAt = performance.now();

    await expect(preflightDocumentParsers(executable)).rejects.toThrow(
      "Document parser output exceeds the configured byte limit",
    );
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(await exists(completionMarker)).toBe(false);
    expect(await processIsRunning(pidFile)).toBe(false);
  });

  test("stdout exactly at the configured byte limit reaches contract validation", async () => {
    const { executable, completionMarker, pidFile } = await createEmitter(
      "stdout",
      STDOUT_LIMIT_BYTES,
    );

    await expect(preflightDocumentParsers(executable)).rejects.toThrow(
      "Document-parser preflight returned an invalid contract",
    );
    expect(await exists(completionMarker)).toBe(true);
    expect(await processIsRunning(pidFile)).toBe(false);
  });

  test("stderr overflow terminates the parser before it can finish emitting", async () => {
    const { executable, completionMarker, pidFile } = await createEmitter(
      "stderr",
      STDERR_LIMIT_BYTES + 1,
      true,
    );
    const startedAt = performance.now();

    await expect(preflightDocumentParsers(executable)).rejects.toThrow(
      "Document parser diagnostic output exceeds the configured byte limit",
    );
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(await exists(completionMarker)).toBe(false);
    expect(await processIsRunning(pidFile)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "stderr overflow terminates descendants that inherit parser pipes",
    async () => {
      const { executable, completionMarker, pidFile, descendantPidFile } = await createEmitter(
        "stderr",
        STDERR_LIMIT_BYTES + 1,
        true,
        true,
      );
      const startedAt = performance.now();

      await expect(preflightDocumentParsers(executable)).rejects.toThrow(
        "Document parser diagnostic output exceeds the configured byte limit",
      );

      expect(performance.now() - startedAt).toBeLessThan(1_500);
      expect(await exists(completionMarker)).toBe(false);
      expect(await processIsRunning(pidFile)).toBe(false);
      expect(await waitUntilStopped(descendantPidFile)).toBe(true);
    },
  );

  test("stderr at the configured byte limit is accepted", async () => {
    const { executable, completionMarker, pidFile } = await createEmitter(
      "stderr",
      STDERR_LIMIT_BYTES,
    );

    const preflight = await preflightDocumentParsers(executable);

    expect(preflight.python).toBe("fixture-python");
    expect(await exists(completionMarker)).toBe(true);
    expect(await processIsRunning(pidFile)).toBe(false);
  });

  test("normalization enforces the same diagnostic-output limit as preflight", async () => {
    const { executable, completionMarker, pidFile } = await createNormalizeOverflowEmitter();
    const normalizer = await createHtmlDocumentNormalizer(executable);

    await expect(normalizer.normalize({
      bytes: Buffer.from("<p>fixture</p>"),
      snapshot: {} as never,
    })).rejects.toThrow(
      "Document parser diagnostic output exceeds the configured byte limit",
    );
    expect(await exists(completionMarker)).toBe(false);
    expect(await processIsRunning(pidFile)).toBe(false);
  });
});

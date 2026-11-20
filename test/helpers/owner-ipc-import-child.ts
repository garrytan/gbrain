/**
 * Child process for test/rust-owner-ipc-import.test.ts. It runs the `gbrain import` command handler
 * (src/cli/commands/import.ts) against one engine and exits with the code the CLI would give, so the test can compare
 * the command's stdout, stderr and exit code between a second process on a Rust brain and a PGLite brain.
 *
 *   bun test/helpers/owner-ipc-import-child.ts <mode> <databasePath> <importDir> [import args...]
 *
 * Modes:
 * - `client`: opens a Rust engine on a store directory whose owner is another process, so `connect` makes it a client
 *   of that owner (src/core/rust-engine/owner-ipc/). It writes `owner-ipc-role=<role>` to stderr as its last line.
 * - `pglite`: opens an in-memory PGLite brain in this process (the reference run); `databasePath` is ignored. With
 *   OWNER_IPC_PAGES_OUT set, it writes the brain's pages (`pageRows`) there as JSON before it closes the brain.
 */
import { openRustEngine } from '../../src/core/rust-engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { currentExitCode } from '../../src/core/cli-force-exit.ts';
import { run } from '../../src/cli/commands/import.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writeFileSync } from 'node:fs';

const [mode, databasePath, importDir, ...extra] = process.argv.slice(2);

/** Every page with the fields an import sets and its chunk text, by slug, so two brains compare as plain data. */
export async function pageRows(engine: BrainEngine): Promise<unknown[]> {
  const pages = (await engine.listPages({ limit: 1000 })).sort((a, b) => a.slug.localeCompare(b.slug));
  const rows = [];
  for (const page of pages) {
    const chunks = await engine.getChunks(page.slug);
    rows.push({ slug: page.slug, type: page.type, title: page.title, compiled_truth: page.compiled_truth,
      timeline: page.timeline, frontmatter: page.frontmatter, chunks: chunks.map(c => c.chunk_text) });
  }
  return rows;
}

async function main(): Promise<number> {
  let engine: BrainEngine;
  let role: string | null = null;
  let close: () => Promise<void>;
  if (mode === 'client') {
    const rust = openRustEngine({ addon: { target: 'linux-x64-glibc', engine_abi: 1 } as never, databasePath: databasePath!, ownerWaitMs: 5_000 });
    await rust.connect({});
    role = rust.ownerRole;
    engine = rust as unknown as BrainEngine;
    close = () => rust.disconnect();
  } else if (mode === 'pglite') {
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    engine = pglite;
    close = () => pglite.disconnect();
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  try {
    await run(engine, [importDir!, ...extra]);
    if (mode === 'pglite' && process.env.OWNER_IPC_PAGES_OUT) {
      writeFileSync(process.env.OWNER_IPC_PAGES_OUT, JSON.stringify(await pageRows(engine)));
    }
  } finally {
    await close();
  }
  if (role) process.stderr.write(`owner-ipc-role=${role}\n`);
  return currentExitCode();
}

if (import.meta.main) {
  main().then(code => process.exit(code), error => {
    process.stderr.write(`fatal: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exit(70);
  });
}

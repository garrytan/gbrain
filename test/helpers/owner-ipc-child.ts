/**
 * Child process for test/rust-owner-ipc.test.ts. It opens a Rust engine on a store directory whose owner is another
 * process, so `connect` makes it a client of that owner (src/core/rust-engine/owner-ipc/), and prints one JSON line.
 *
 *   bun test/helpers/owner-ipc-child.ts <mode> <databasePath> <worker>
 *
 * Modes:
 * - `write`: puts five pages, links and timeline entries, and imports one page with importFromContent and one file
 *   with importFromFile.
 * - `read`:  runs the reads engine-bench uses and prints each result as JSON (compared byte for byte in the test).
 * - `owner`: hosts an in-memory PGLite engine as the owner (election.ts), with a slow `getHealth` that honours the
 *   request signal, prints `ready`, and waits to be killed.
 */
import { openRustEngine } from '../../src/core/rust-engine.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const [mode, databasePath, workerText] = process.argv.slice(2);
const worker = Number(workerText ?? 0);
const addon = { target: 'linux-x64-glibc', engine_abi: 1 } as never;

/** The error fields a caller sees, in a fixed order, so two processes compare byte for byte. */
export function errorShape(error: unknown): Record<string, unknown> {
  const e = error as Record<string, unknown> & Error;
  return { name: e?.name, message: e?.message, ...Object.fromEntries(Object.entries(e ?? {})) };
}

async function settle(fn: () => Promise<unknown>): Promise<unknown> {
  try { return { ok: await fn() }; } catch (error) { return { error: errorShape(error) }; }
}

/** The read script, shared with the test so the in-process run is the same calls. */
export async function readScript(engine: BrainEngine): Promise<Record<string, unknown>> {
  return {
    get: await settle(() => engine.getPage('ipc/w0-0')),
    missing: await settle(() => engine.getPage('ipc/none')),
    list: await settle(() => engine.listPages({ limit: 50 })),
    keyword: await settle(() => engine.searchKeyword('owner socket', { limit: 10 })),
    vector: await settle(() => engine.searchVector(new Float32Array(1536), { limit: 5 })),
    hybrid: await settle(() => hybridSearch(engine, 'owner socket', { limit: 5 })),
    backlinks: await settle(() => engine.getBacklinks('ipc/w0-0')),
    timeline: await settle(() => engine.getTimeline('ipc/w1-0')),
    graph: await settle(() => engine.traverseGraph('ipc/w0-1', 2)),
    imported: await settle(() => engine.getPage('ipc/imported-1')),
  };
}

async function writeScript(engine: BrainEngine): Promise<Record<string, unknown>> {
  const slugs: string[] = [];
  for (let n = 0; n < 5; n++) {
    const slug = `ipc/w${worker}-${n}`;
    await engine.putPage(slug, {
      type: 'note', title: `Worker ${worker} page ${n}`,
      compiled_truth: `Page ${n} from worker ${worker}, written through the owner socket.`,
    });
    slugs.push(slug);
  }
  for (let n = 1; n < 5; n++) await engine.addLink(`ipc/w${worker}-${n}`, `ipc/w${worker}-0`, 'see', 'mentions');
  await engine.addTimelineEntry(`ipc/w${worker}-0`, { date: '2026-11-17', summary: `worker ${worker} wrote its pages` });
  const imported = await importFromContent(engine, `ipc/imported-${worker}`,
    `---\ntitle: Imported by worker ${worker}\ntype: note\n---\nThis page came in through the owner socket as one whole import.\n`,
    { noEmbed: true });
  const fileDir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-file-'));
  try {
    const file = join(fileDir, `file-${worker}.md`);
    writeFileSync(file, `---\ntitle: File from worker ${worker}\ntype: note\n---\nA file import sent whole to the owner.\n`);
    const fromFile = await importFromFile(engine, file, `ipc/file-${worker}.md`, { noEmbed: true });
    return { slugs, imported: { slug: imported.slug, status: imported.status }, fromFile: { slug: fromFile.slug, status: fromFile.status } };
  } finally { rmSync(fileDir, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  if (mode === 'owner') {
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const { electOwner } = await import('../../src/core/rust-engine/owner-ipc/election.ts');
    const { ownerWholeOperations } = await import('../../src/core/rust-engine/owner-ipc/owner-ops.ts');
    const { requestSignal } = await import('../../src/core/request-signal.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    (engine as unknown as Record<string, unknown>).getHealth = () => new Promise((_resolve, reject) => {
      requestSignal()?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const role = await electOwner(engine, databasePath, { wholeOperations: ownerWholeOperations() });
    process.stdout.write(`${JSON.stringify({ role: role.role, pid: process.pid })}\n`);
    await new Promise(() => {});
    return;
  }
  const engine = openRustEngine({ addon, databasePath, ownerWaitMs: 5_000 });
  await engine.connect({});
  const brain = engine as unknown as BrainEngine;
  let out: Record<string, unknown>;
  if (mode === 'write') out = await writeScript(brain);
  else if (mode === 'read') out = await readScript(brain);
  else throw new Error(`unknown mode ${mode}`);
  out.role = engine.ownerRole;
  await engine.disconnect();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ fatal: errorShape(error), stack: (error as Error)?.stack })}\n`);
    process.exit(1);
  });
}

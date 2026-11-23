/**
 * A segmented page's lead (a bounded prefix of its body) is shown through the withdrawal overlay: a world claim a
 * person withdrew must not appear in it (page-window/bounded-lead.ts). The overlay reads the withdrawals the page
 * snapshot carries, so the Rust engine's snapshot must carry the withdrawals its own ledger holds.
 *
 * Authoring gate (docs/TESTING.md): protects what an agent or user reads in a lead, snippet or synopsis of a large page
 * on a Rust brain: a withdrawn world claim stays hidden. A regression is a snapshot that reports `withdrawals: []` while
 * the ledger holds one, which makes the overlay a no-op and shows the claim. bounded-lead.test.ts runs the same helper
 * over PGLite only, so no existing test crosses the Rust snapshot. No production seam: the real engine and helper.
 * The addon tests need `bun run rust:build` (rust/target/addon) and skip without it, as rust-engine-store.test.ts does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { pageSnapshotKey } from '../src/core/page-snapshot-batch.ts';
import { overlaidBoundedRows } from '../src/core/page-window/bounded-lead.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1') {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const dirs: string[] = [];
const engines: RustEngine[] = [];
let addon: RustAddon | undefined;

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WITHDRAWN_CLAIM = 'Withdrawn world claim about the example company';
const KEPT_CLAIM = 'Kept world claim about the example company';
const LEAD = `Intro prose.\n\n${renderFactsTable([
  { rowNum: 1, claim: WITHDRAWN_CLAIM, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 2, claim: KEPT_CLAIM, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
] as never)}\n\nClosing prose.`;

async function openSegmentedBrain(): Promise<{ engine: RustEngine; brain: { insertFactWithdrawal: (...args: unknown[]) => Promise<boolean> } }> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-withdrawn-lead-'));
  dirs.push(dir);
  const engine = openRustEngine({ addon, databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  await engine.createSegmentedPageShell('people/example', { type: 'person', title: 'Example', frontmatter: {} }, { sourceId: 'default' });
  return { engine, brain: engine.openStore('test').brain as never };
}

describe('the lead of a segmented page on a Rust brain', () => {
  withAddon('does not show a world claim the ledger says was withdrawn', async () => {
    const { engine, brain } = await openSegmentedBrain();
    expect(await brain.insertFactWithdrawal('default', 'world', WITHDRAWN_CLAIM, 'people/example', null)).toBe(true);
    const snapshot = await engine.readPageSnapshot('people/example', { sourceId: 'default' });
    expect(snapshot?.withdrawals.map(w => w.visibility)).toEqual(['world']);
    const batch = await engine.readPageSnapshotsBatch([{ slug: 'people/example', sourceId: 'default' }]);
    expect(batch.snapshots.get(pageSnapshotKey('default', 'people/example'))?.withdrawals).toEqual(snapshot!.withdrawals);
    const [row] = await overlaidBoundedRows(engine, [{ slug: 'people/example', source_id: 'default', compiled_truth: LEAD }]);
    // The withdrawn claim never reaches the reader; the overlay may strike it or, with no SQL on this engine, fail closed.
    expect(row!.compiled_truth).not.toContain(WITHDRAWN_CLAIM);
  });

  withAddon('is left as it is when nothing was withdrawn', async () => {
    const { engine } = await openSegmentedBrain();
    const snapshot = await engine.readPageSnapshot('people/example', { sourceId: 'default' });
    expect(snapshot?.withdrawals).toEqual([]);
    const [row] = await overlaidBoundedRows(engine, [{ slug: 'people/example', source_id: 'default', compiled_truth: LEAD }]);
    expect(row!.compiled_truth).toContain(WITHDRAWN_CLAIM);
  });
});

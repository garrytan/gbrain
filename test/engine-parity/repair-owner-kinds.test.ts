/**
 * BrainEngine parity — `gbrain repair ghost-pages`, `legacy-twins` and `rows-behind` on a brain with no owner binding
 * (batch 3 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain whose default source has file-backed pages and no worktree binding, the preview and the apply
 *    of each kind give the same result or the same refusal code on PGLite, Postgres (DATABASE_URL) and the Rust engine
 *    (GBRAIN_TEST_RUST_ARM=1): ghost-pages and legacy-twins refuse `not_owner_host`, and rows-behind previews no rows
 *    and refuses an apply no preview printed.
 *  - Regression: each kind reads the source's owner binding first; before batch 3, a Rust brain stopped earlier at a
 *    raw page or source read, so the three arms disagreed on the refusal.
 *  - Why existing coverage misses it: test/repair-legacy-twins-6885.test.ts, test/ghost-pages-*.test.ts and the
 *    rows-behind tests run on PGLite or Postgres only.
 *  - Seam: none. A brain with a binding is out of reach here: the binding is a persistence_journal record, which a Rust
 *    brain does not serve yet, so the owner-host path of these kinds is pinned in the persistence batch.
 */
import { describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>'));
}

/** A preview, then an apply of what it printed; a refusal is kept as its code and message. */
async function run(engine: BrainEngine, kind: RepairKind) {
  const attempt = async (apply: boolean, expect?: string) => {
    try {
      const scope = await resolveRepairScope(engine);
      return shape(await (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true, ...(expect ? { expect } : {}) }));
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { refused: e.code ?? 'unknown', message: e.message };
    }
  };
  const preview = await attempt(false);
  const hash = 'preview_hash' in preview ? preview.preview_hash as string | undefined : undefined;
  return { preview, apply: await attempt(true, hash) };
}

describe('engine parity: repair kinds that need the owner host', () => {
  parityTest('ghost-pages, legacy-twins and rows-behind answer alike on a brain with no owner binding', {
    methods: ['putPage', 'getWorktreeBinding'],
    timeout: 60_000,
  }, async (engine) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-owner-kinds-home-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await engine.putPage('notes/a-example', { type: 'note', title: 'a', compiled_truth: 'a body', timeline: '', source_path: 'notes/a-example.md' }, { sourceId: 'default' });
        await engine.putPage('notes/a-example-2', { type: 'note', title: 'a', compiled_truth: 'a body', timeline: '' }, { sourceId: 'default' });
        const out: Record<string, unknown> = {};
        for (const kind of ['ghost-pages', 'legacy-twins', 'rows-behind'] as const) out[kind] = await run(engine, kind);
        out.binding = await engine.getWorktreeBinding('default', null);
        return out;
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

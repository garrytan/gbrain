/**
 * BrainEngine parity: `gbrain repair slug-spelling` moves a page stored under an older spelling of its name to the
 * normal slug (lowercase, then Unicode NFC) and lists a page whose normal slug is already taken as needing a person.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite and (with DATABASE_URL) Postgres the preview names the same classes, the apply with its hash
 *    moves the same pages and keeps their ids, the collision stays where it was, and a second apply moves nothing.
 *    On the Rust arm (GBRAIN_TEST_RUST_ARM=1) the case stops on the typed refusal below.
 *  - Regression: PR 9944 left such pages with no way to move; a repair that moved the row on one engine only, or lost
 *    the page id, would answer differently here.
 *  - Why existing coverage misses it: test/repair-slug-spelling.test.ts runs PGLite only.
 *  - Seam: none. Real engines; the repair runs through the CLI entry point.
 *
 * Rust arm known stops (each case asserts the exact Rust answer, then rethrows):
 *  - repair slug-spelling: member `executeRaw`, capability `raw_sql` (Rust raw-sql area): the case stores a page under an
 *    older spelling by renaming its row, and the repair itself reads and moves slug-keyed rows with SQL. The Rust store has
 *    no `recordRenameAlias` / `moveSlugBindings` either, so the repair is refused on it until the Rust store serves them.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { _resetCliExitVerdictForTests } from '../../src/core/cli-force-exit.ts';

const arms = parityArms(testBackends());
const parityTest: typeof arms.parityTest = (name, opts, scenario) => arms.parityTest(name, opts, async (engine, ...rest) => {
  try { return await scenario(engine, ...rest); } finally { await disposePersistenceConsumer(engine); }
});

const RUST_RAW_SQL_STOP = "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran.";

async function repairJson(engine: BrainEngine, args: string[]) {
  const { runRepairCommand } = await import('../../src/commands/repair.ts');
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await runRepairCommand(engine, [...args, '--json']); } finally { console.log = original; process.stdout.write = write; }
  return JSON.parse(printed).results[0] as { preview_hash?: string; listing?: Array<{ item: string; class: string }>; applied?: number; outcomes?: Record<string, number>; failed?: unknown[] };
}

describe('engine parity: repair slug-spelling', () => {
  parityTest('a page stored under an older spelling moves to its normal slug with its id kept, a collision stays, and a second apply moves nothing', { methods: ['putPage', 'readPageSnapshot'], requires: 'raw_sql' }, async (engine, backend) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-slug-spelling-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_INTERACTIVE: '0', CI: '1' }, async () => {
        _resetCliExitVerdictForTests();
        const put = (slug: string, title: string) => engine.putPage(slug, { type: 'note', title, compiled_truth: `${title}.`, timeline: '' });
        await put('notes/pm-alpha', 'Alpha');
        await put('notes/pm-cafe', 'Cafe');
        await put('notes/pm-two', 'Two stored');
        try {
          await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', ['Notes/Pm-Alpha', 'notes/pm-alpha']);
          await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', ['notes/pm-cafe\u0301', 'notes/pm-cafe']);
          await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', ['Notes/Pm-Two', 'notes/pm-two']);
        } catch (e) {
          if (backend === 'rust') expect((e as Error).message).toBe(RUST_RAW_SQL_STOP);
          throw e;
        }
        await put('notes/pm-two', 'Two normal');
        const ids = async (slugs: string[]) => Promise.all(slugs.map(async slug => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.id ?? null));
        const before = await ids(['Notes/Pm-Alpha', 'notes/pm-cafe\u0301']);
        const preview = await repairJson(engine, ['slug-spelling', '--source', 'default']);
        const apply = ['slug-spelling', '--source', 'default', '--apply', '--expect', preview.preview_hash!, '--yes'];
        const applied = await repairJson(engine, apply);
        const again = await repairJson(engine, apply);
        const after = await ids(['notes/pm-alpha', 'notes/pm-caf\u00e9']);
        const slugs = (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages')).map(r => r.slug).sort(); // code-point order, whatever the database collation
        const result = { classes: Object.fromEntries((preview.listing ?? []).map(entry => [entry.item, entry.class])), applied: applied.applied, outcomes: applied.outcomes,
          again: { applied: again.applied, outcomes: again.outcomes }, sameIds: JSON.stringify(before) === JSON.stringify(after), slugs };
        expect(result).toEqual({
          classes: { 'default:Notes/Pm-Alpha': 'move', 'default:notes/pm-cafe\u0301': 'move', 'default:Notes/Pm-Two': 'needs_human' },
          applied: 2, outcomes: { moved: 2 }, again: { applied: 0, outcomes: { already_moved: 2 } }, sameIds: true,
          slugs: ['Notes/Pm-Two', 'notes/pm-alpha', 'notes/pm-caf\u00e9', 'notes/pm-two'],
        });
        return result;
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

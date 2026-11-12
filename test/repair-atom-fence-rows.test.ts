/**
 * `gbrain repair atom-fence-rows` and doctor's `atom_fence_rows`, on PGLite and Postgres.
 *
 * World atoms an earlier extraction produced from the whole page can carry the claim of a facts row whose visibility
 * is not world, or of a takes row held by someone other than world, and a remote read of the atom returns it. Doctor
 * counts them per source and names the read-only preview; the preview lists them (slug, source page, row kind and
 * number, never the row text) and changes nothing; only --apply --expect <hash> narrows exactly that set to private.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { atomFenceRowsCheck } from '../src/commands/doctor/checks/atom-fence-rows.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { FENCES, HIDDEN_TAKE_ROW, PRIVATE_ROW, WORLD_PAGE_BODY, WORLD_ROW } from './helpers/world-fence-page.ts';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number; skipped: number;
  listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number> }> }

const ORIGIN = 'notes/launch-review';
const CARRIES_FACT = 'atoms/2026-01-01/renewal-terms';
const CARRIES_TAKE = 'atoms/2026-01-01/launch-move';
const CLEAN = 'atoms/2026-01-01/launch-checklist';
const ALREADY_PRIVATE = 'atoms/2026-01-01/renewal-terms-private';

test('atom_fence_rows is a host-only wave check that names the atom-fence-rows repair', () => {
  const spec = WAVE_CHECKS.find(check => check.id === 'atom_fence_rows');
  expect(spec).toMatchObject({ resolution: 'repair', registration: 'wave' });
  expect(spec!.hostOnly).toBeTruthy();
});

for (const kind of testBackends()) {
  describe(`gbrain repair atom-fence-rows (${kind})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    let sourceId: string;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-atom-fence-rows-'));

    const putAtom = (slug: string, body: string, frontmatter: Record<string, unknown>) =>
      engine.putPage(slug, { type: 'atom', title: slug.split('/').at(-1)!, compiled_truth: body,
        frontmatter: { type: 'atom', atom_type: 'insight', source_slug: ORIGIN, source_hash: 'aaaaaaaaaaaaaaaa', visibility: 'world', dream_generated: true,
          extracted_by: 'extract_atoms-v0.41.2.1', ...frontmatter } }, { sourceId });

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      sourceId = `fence-rows-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage(ORIGIN, { type: 'note', title: 'Launch review', compiled_truth: WORLD_PAGE_BODY, timeline: '' }, { sourceId });
      await putAtom(CARRIES_FACT, `Recorded on the page: ${PRIVATE_ROW}.`, {});
      await putAtom(CARRIES_TAKE, 'A launch decision was recorded.', { source_quote: HIDDEN_TAKE_ROW });
      await putAtom(CLEAN, `Recorded on the page: ${WORLD_ROW}.`, { source_quote: WORLD_ROW });
      await putAtom(ALREADY_PRIVATE, `Recorded on the page: ${PRIVATE_ROW}.`, { visibility: 'private' });
    }, 120_000);
    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      if (close) await close(); else await engine.disconnect();
      resetGateway();
      rmSync(home, { recursive: true, force: true });
    });

    const repair = async (args: string[]): Promise<RepairJson> => {
      const lines: string[] = [];
      const original = console.log;
      console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      try { await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, ['atom-fence-rows', '--source', sourceId, ...args, '--json'])); } finally { console.log = original; }
      return JSON.parse(lines.join('\n')) as RepairJson;
    };
    const atoms = () => engine.executeRaw<{ slug: string; visibility: string; revision: string }>(
      `SELECT slug, frontmatter->>'visibility' AS visibility, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND type='atom' ORDER BY slug`, [sourceId]);
    const remoteGet = async (slug: string) => {
      try {
        const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'stdio', sourceId, takesHoldersAllowList: ['world'] });
        return out.content.map(c => c.text).join('\n');
      } catch (error) { return String(error); }
    };

    test('doctor warns with the count and the preview command, the preview lists exactly the carrying atoms and changes nothing, the apply narrows them', async () => {
      expect(await remoteGet(CARRIES_FACT)).toContain(PRIVATE_ROW);

      const finding = await atomFenceRowsCheck(engine, [sourceId]);
      expect(finding.status).toBe('warn');
      expect(finding.details).toMatchObject({ count: 2, repair: 'atom-fence-rows' });
      expect(finding.message).toContain(`gbrain repair atom-fence-rows --source ${sourceId} --json`);
      expect(JSON.stringify(finding)).not.toContain(PRIVATE_ROW);
      expect(JSON.stringify(finding)).not.toContain(CARRIES_FACT);

      const before = await atoms();
      const preview = await repair([]);
      const result = preview.results[0]!;
      expect(result.listing!.map(row => ({ item: row.item, class: row.class, detail: row.detail })).sort((a, b) => a.item.localeCompare(b.item))).toEqual([
        { item: `${sourceId}:${CARRIES_TAKE}`, class: 'takes', detail: `source page ${ORIGIN}: takes row 1` },
        { item: `${sourceId}:${CARRIES_FACT}`, class: 'facts', detail: `source page ${ORIGIN}: facts row 2` },
      ].sort((a, b) => a.item.localeCompare(b.item)));
      expect(JSON.stringify(preview)).not.toContain(PRIVATE_ROW);
      expect(JSON.stringify(preview)).not.toContain(HIDDEN_TAKE_ROW);
      expect(await atoms()).toEqual(before);

      const unbound = await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, ['atom-fence-rows', '--source', sourceId, '--apply', '--json']))
        .then(() => null, (error: unknown) => error);
      expect(unbound).toBeInstanceOf(OperationError);
      expect(await atoms()).toEqual(before);

      const hash = result.apply_command.match(/--expect ([0-9a-f]+)/)![1]!;
      const applied = (await repair(['--apply', '--expect', hash])).results[0]!;
      expect(applied.applied).toBe(2);
      expect(applied.outcomes).toMatchObject({ narrowed: 2 });
      const after = Object.fromEntries((await atoms()).map(row => [row.slug, row.visibility]));
      expect(after).toEqual({ [CARRIES_FACT]: 'private', [CARRIES_TAKE]: 'private', [CLEAN]: 'world', [ALREADY_PRIVATE]: 'private' });
      expect(await remoteGet(CARRIES_FACT)).not.toContain(PRIVATE_ROW);
      expect(await remoteGet(CARRIES_TAKE)).not.toContain(HIDDEN_TAKE_ROW);
      expect(await remoteGet(CLEAN)).toContain(WORLD_ROW);

      expect((await atomFenceRowsCheck(engine, [sourceId])).status).toBe('ok');
      expect((await repair([])).results[0]!.listing ?? []).toEqual([]);
    }, 120_000);

    test('a fence quoted in a code block counts as hidden, as it does for a world reader', async () => {
      const quotedOrigin = 'notes/launch-review-quoted';
      const quotedAtom = 'atoms/2026-01-01/renewal-terms-quoted';
      await engine.putPage(quotedOrigin, { type: 'note', title: 'Launch review quoted', compiled_truth: `# Launch review\n\n\`\`\`markdown\n${FENCES}\`\`\`\n`, timeline: '' }, { sourceId });
      await putAtom(quotedAtom, `Recorded on the page: ${PRIVATE_ROW}.`, { source_slug: quotedOrigin });
      expect(await remoteGet(quotedOrigin)).not.toContain(PRIVATE_ROW);

      const finding = await atomFenceRowsCheck(engine, [sourceId]);
      expect(finding.status).toBe('warn');
      expect(finding.details).toMatchObject({ count: 1 });
      const listing = (await repair([])).results[0]!.listing!;
      expect(listing.map(row => ({ item: row.item, class: row.class, detail: row.detail }))).toEqual([
        { item: `${sourceId}:${quotedAtom}`, class: 'facts', detail: `source page ${quotedOrigin}: facts row 2` },
      ]);
    }, 120_000);
    test('managed brain: the apply narrows the previewed atom through the coordinator', async () => {
      await managedBrain(async ({ engine: brain }) => {
        const run = async (args: string[]): Promise<RepairJson> => {
          const lines: string[] = [];
          const original = console.log;
          console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
          try { await runRepairCommand(brain, ['atom-fence-rows', '--source', 'default', ...args, '--json']); } finally { console.log = original; }
          return JSON.parse(lines.join('\n')) as RepairJson;
        };
        expect((await atomFenceRowsCheck(brain, ['default'])).details).toMatchObject({ count: 1 });
        const preview = (await run([])).results[0]!;
        expect(preview.listing!.map(row => row.item)).toEqual([`default:${CARRIES_FACT}`]);
        const hash = preview.apply_command.match(/--expect ([0-9a-f]+)/)![1]!;
        const applied = (await run(['--apply', '--expect', hash])).results[0]!;
        await disposePersistenceConsumer(brain);
        expect(applied.outcomes).toMatchObject({ narrowed: 1 });
        const [row] = await brain.executeRaw<{ visibility: string }>(
          `SELECT frontmatter->>'visibility' AS visibility FROM pages WHERE source_id='default' AND slug=$1`, [CARRIES_FACT]);
        expect(row!.visibility).toBe('private');
        expect((await atomFenceRowsCheck(brain, ['default'])).status).toBe('ok');
      }, { databaseUrl: kind === 'postgres' ? requirePostgresTestDatabase() : undefined, setup: async ({ engine: brain }) => {
        await brain.putPage(ORIGIN, { type: 'note', title: 'Launch review', compiled_truth: WORLD_PAGE_BODY, timeline: '' }, { sourceId: 'default' });
        await brain.putPage(CARRIES_FACT, { type: 'atom', title: 'renewal-terms', compiled_truth: `Recorded on the page: ${PRIVATE_ROW}.`,
          frontmatter: { type: 'atom', atom_type: 'insight', source_slug: ORIGIN, source_hash: 'aaaaaaaaaaaaaaaa', visibility: 'world', dream_generated: true,
            managed_extraction: true, extracted_by: 'extract_atoms-v0.41.2.1' } }, { sourceId: 'default' });
      } });
    }, 180_000);
  });
}

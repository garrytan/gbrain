/**
 * #9653 last review round: the unchanged-concept refresh skips a concept that moved since the cycle read it; a purge
 * whose walk hit its limit still marks the versions it reached; a version's mark keeps the version's own source, so
 * removing the purged input's source leaves it hidden; and the reason a hidden version was written for is withheld
 * from the version before it. PGLite and, with DATABASE_URL, Postgres. Synthetic ids and data only.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { replaceConceptInputs } from '../src/core/cycle/concept-publication.ts';
import { derivedRowsFrom, hideDerivedRows, pageInputIds } from '../src/core/facts/derivation-inputs.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const text = (title: string, body: string, type = 'note') => ['---', `type: ${type}`, `title: ${title}`, '---', `# ${title}`, '', body].join('\n');
const idOf = async (engine: BrainEngine, slug: string, source = 'default') =>
  String((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1 AND source_id=$2', [slug, source]))[0]!.id);
const edge = (engine: BrainEngine, derivedTable: string, derivedId: string, inputId: string, source: string) => engine.executeRaw(
  `INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id) VALUES($1,$2,'pages',$3,$4)`, [derivedTable, derivedId, inputId, source]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const world = (run: (engine: BrainEngine) => Promise<void>) => withEnv({ DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await run(engine);
    } finally { await close(); }
  });

  describe(`#9653 purge follow-ups (${backend})`, () => {
    test('the unchanged-concept refresh writes nothing when the concept moved since it was read', () => world(async engine => {
      for (const i of [0, 1]) await importFromContent(engine, `atoms/dock-${i}`, text(`atom ${i}`, `Atom ${i} about docks.`, 'atom'), { noEmbed: true });
      await importFromContent(engine, 'concepts/dock-example', text('Dock', 'Narrative about docks.', 'concept'), { noEmbed: true });
      await replaceConceptInputs(engine, 'default', 'concepts/dock-example', ['atoms/dock-0', 'atoms/dock-1']);
      const concept = { table: 'pages', id: await idOf(engine, 'concepts/dock-example') };
      const before = (await pageInputIds(engine, concept)).sort();
      expect(before).toEqual([await idOf(engine, 'atoms/dock-0'), await idOf(engine, 'atoms/dock-1')].sort());
      expect(await replaceConceptInputs(engine, 'default', 'concepts/dock-example', ['atoms/dock-1'], { expectedRevision: '00000000-0000-4000-8000-000000000000' })).toBe(false);
      expect((await pageInputIds(engine, concept)).sort()).toEqual(before);
      const revision = (await engine.readPageSnapshot('concepts/dock-example', { sourceId: 'default' }))!.revision;
      expect(await replaceConceptInputs(engine, 'default', 'concepts/dock-example', ['atoms/dock-1'], { expectedRevision: revision })).toBe(true);
      expect(await pageInputIds(engine, concept)).toEqual([await idOf(engine, 'atoms/dock-1')]);
    }), 120_000);

    test('a walk stopped by its limit still returns the versions built from the input', () => world(async engine => {
      for (const id of ['8001', '8002']) await edge(engine, 'pages', id, '42', 'default');
      await edge(engine, 'page_versions', '9100', '42', 'default');
      const walk = await derivedRowsFrom(engine, [{ table: 'pages', id: '42' }], { limit: 1 });
      expect(walk.truncated).toBe(true);
      expect(walk.rows.filter(r => r.table === 'page_versions').map(r => r.id)).toEqual(['9100']);
    }), 120_000);

    test('a version\'s mark keeps its own source, so removing the purged input\'s source leaves it hidden', () => world(async engine => {
      for (const id of ['src-a', 'src-b']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      await importFromContent(engine, 'chats/quay-chat', text('Chat', 'Chat about quays.'), { sourceId: 'src-a', noEmbed: true });
      await importFromContent(engine, 'concepts/quay-example', text('Quay', 'Narrative canaryquay from the chat.', 'concept'), { sourceId: 'src-b', noEmbed: true });
      await importFromContent(engine, 'concepts/quay-example', text('Quay', 'Narrative rebuilt without it.', 'concept'), { sourceId: 'src-b', noEmbed: true });
      const old = (await engine.getVersions('concepts/quay-example', { sourceId: 'src-b' })).find(v => String(v.compiled_truth).includes('canaryquay'))!;
      expect(old).toBeDefined();
      await edge(engine, 'page_versions', String(old.id), await idOf(engine, 'chats/quay-chat', 'src-a'), 'src-a');
      const { rows } = await derivedRowsFrom(engine, [{ table: 'pages', id: await idOf(engine, 'chats/quay-chat', 'src-a') }]);
      await engine.transaction(tx => hideDerivedRows(tx, rows, { sourceId: 'src-a', requestId: null, reason: 'purge:test' }));
      expect(await engine.executeRaw('SELECT source_id FROM needs_rederive WHERE derived_table=$1 AND derived_id=$2', ['page_versions', String(old.id)])).toEqual([{ source_id: 'src-b' }]);
      await engine.executeRaw("DELETE FROM sources WHERE id='src-a'");
      expect(JSON.stringify(await engine.getVersions('concepts/quay-example', { sourceId: 'src-b' }))).not.toContain('canaryquay');
    }), 120_000);

    test('the reason for a write whose version is hidden is withheld from the version it replaced', () => world(async engine => {
      for (const n of ['one', 'two', 'three']) await importFromContent(engine, 'concepts/pier-example', text('Pier', `Edition ${n}.`, 'concept'), { noEmbed: true });
      const history = await engine.getVersions('concepts/pier-example', { sourceId: 'default' });
      const first = history.find(v => String(v.compiled_truth).includes('Edition one'))!;
      const second = history.find(v => String(v.compiled_truth).includes('Edition two'))!;
      await engine.executeRaw("UPDATE page_versions SET change_reason='canaryreason' WHERE id=$1", [first.id]);
      expect((await engine.getVersions('concepts/pier-example', { sourceId: 'default' })).find(v => v.id === first.id)).toMatchObject({ replaced_because: 'canaryreason' });
      await engine.transaction(tx => hideDerivedRows(tx, [{ table: 'page_versions', id: String(second.id), depth: 1 }], { sourceId: 'default', requestId: null, reason: 'purge:test' }));
      const after = await engine.getVersions('concepts/pier-example', { sourceId: 'default' });
      expect(after.map(v => v.id)).not.toContain(second.id);
      expect(after.find(v => v.id === first.id)?.replaced_because ?? null).toBeNull();
    }), 120_000);
  });
}

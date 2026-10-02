/**
 * `gbrain repair stale-atoms` (#5770, CEO-A7, ENG-O7, DX-O4), on PGLite and,
 * with a safe DATABASE_URL, Postgres (test/e2e/repair-stale-atoms-postgres.test.ts).
 *
 * Unmanaged and managed brains: the preview lists both classes and changes
 * nothing; the apply needs the preview hash and retires exactly the previewed
 * set; an atom that changed since the preview is kept as changed_since_preview;
 * imported and file-bound atoms survive; on a managed brain a deleted page's
 * atoms come back when the page is restored and extracted again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { runPhaseExtractAtoms, discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { operations } from '../src/core/operations.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number; skipped: number;
  listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number>; outcome_items?: Array<{ item: string; outcome: string }> }> }

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

test('stale-atoms is CLI-only: no operation exposes it over MCP (ENG-O13)', () => {
  expect(operations.map(op => op.name).filter(name => /stale|repair/.test(name))).toEqual([]);
});

for (const kind of testBackends()) {
  describe(`gbrain repair stale-atoms (${kind})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-stale-atoms-'));
    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
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
      try { await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, ['stale-atoms', ...args, '--json'])); } finally { console.log = original; }
      return JSON.parse(lines.join('\n')) as RepairJson;
    };
    const hashOf = (json: RepairJson) => json.results[0].apply_command.match(/--expect ([0-9a-f]+)/)![1];
    const atom = async (sourceId: string, slug: string) => (await engine.executeRaw<{ deleted: boolean; frontmatter: Record<string, unknown> }>(
      'SELECT deleted_at IS NOT NULL AS deleted, frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];
    const putAtom = (sourceId: string, slug: string, frontmatter: Record<string, unknown>) =>
      engine.putPage(slug, { type: 'atom', title: slug, compiled_truth: `Claim ${slug}.`, frontmatter: { type: 'atom', ...frontmatter } }, { sourceId });

    async function unmanagedFixture() {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const sourceId = `stale-u-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const edited = await engine.putPage('notes/edited', { type: 'note', title: 'Edited', compiled_truth: 'The current text of the edited page.' }, { sourceId });
      await putAtom(sourceId, 'atoms/2026-01-01/edited-old', { source_slug: 'notes/edited', source_hash: 'aaaaaaaaaaaaaaaa' });
      await putAtom(sourceId, 'atoms/2026-01-01/edited-current', { source_slug: 'notes/edited', source_hash: edited.content_hash!.slice(0, 16) });
      await engine.putPage('notes/unextracted', { type: 'note', title: 'Unextracted', compiled_truth: 'Edited but not extracted again.' }, { sourceId });
      await putAtom(sourceId, 'atoms/2026-01-01/unextracted-old', { source_slug: 'notes/unextracted', source_hash: 'bbbbbbbbbbbbbbbb' });
      await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'A page the user deleted.' }, { sourceId });
      await putAtom(sourceId, 'atoms/2026-01-01/gone', { source_slug: 'notes/gone', source_hash: 'cccccccccccccccc' });
      await putAtom(sourceId, 'atoms/2026-01-01/imported', { source_slug: 'notes/gone', source_hash: 'cccccccccccccccc', imported_from: 'brain-export' });
      await putAtom(sourceId, 'atoms/2026-01-01/file-bound', { source_path: '/transcripts/meeting.txt', source_hash: 'dddddddddddddddd' });
      await engine.softDeletePage('notes/gone', { sourceId });
      await putAtom(sourceId, 'atoms/2026-01-01/orphan', { source_slug: 'notes/never-existed', source_hash: 'eeeeeeeeeeeeeeee' });
      return sourceId;
    }

    test('unmanaged: the preview lists both classes and changes nothing; the apply needs its hash and retires exactly them', async () => {
      const sourceId = await unmanagedFixture();
      const preview = await repair(['--source', sourceId]);
      expect(preview.results[0].listing).toEqual([
        { item: `${sourceId}:atoms/2026-01-01/gone`, class: 'origin_gone', detail: 'source page notes/gone is gone' },
        { item: `${sourceId}:atoms/2026-01-01/orphan`, class: 'origin_gone', detail: 'source page notes/never-existed is gone' },
        { item: `${sourceId}:atoms/2026-01-01/edited-old`, class: 'origin_changed', detail: expect.stringContaining('source page notes/edited now at') },
      ]);
      expect(preview.results[0].residuals).toEqual({ origin_gone: 2, origin_changed: 1 });
      const hash = hashOf(preview);
      expect(preview.results[0].apply_command).toBe(`gbrain repair stale-atoms --source ${sourceId} --apply --expect ${hash}`);
      for (const slug of ['gone', 'orphan', 'edited-old']) expect((await atom(sourceId, `atoms/2026-01-01/${slug}`)).deleted).toBe(false);

      const unbound = await refusal(() => repair(['--source', sourceId, '--apply']));
      expect(unbound.toJSON()).toMatchObject({ error: 'invalid_params', docs: 'docs/guides/repair.md#explicit-only-repair-kinds',
        suggestion: `Preview first: gbrain repair stale-atoms --source ${sourceId} — then run the apply command it prints: gbrain repair stale-atoms --source ${sourceId} --apply --expect <preview-hash>` });
      const stale = await refusal(() => repair(['--source', sourceId, '--apply', '--expect', 'f'.repeat(64)]));
      expect(stale.toJSON()).toMatchObject({ error: 'preview_changed', docs: 'docs/guides/repair.md#preview-changed',
        message: `The preview changed since ${'f'.repeat(64)}; re-run gbrain repair stale-atoms --source ${sourceId} and use the new hash.` });

      const applied = await repair(['--source', sourceId, '--apply', '--expect', hash]);
      expect(applied.results[0]).toMatchObject({ applied: 3, skipped: 0, outcomes: { retired: 3 } });
      for (const slug of ['gone', 'orphan', 'edited-old']) {
        const row = await atom(sourceId, `atoms/2026-01-01/${slug}`);
        expect(row.deleted).toBe(true);
        expect(row.frontmatter.retired_by).toBe('stale-atoms');
      }
      for (const slug of ['edited-current', 'unextracted-old', 'imported', 'file-bound']) expect((await atom(sourceId, `atoms/2026-01-01/${slug}`)).deleted).toBe(false);
      expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='repair-approval' AND fingerprint=$1", [`stale-atoms:${hash}`])).toEqual([]);
      expect((await repair(['--source', sourceId])).results[0].affected).toBe(0);
    }, 60_000);

    test('unmanaged: an atom edited between preview and apply reports changed_since_preview and is kept', async () => {
      const sourceId = await unmanagedFixture();
      const hash = hashOf(await repair(['--source', sourceId]));
      await putAtom(sourceId, 'atoms/2026-01-01/orphan', { source_slug: 'notes/never-existed', source_hash: 'eeeeeeeeeeeeeeee', note: 'edited after the preview' });
      const applied = await repair(['--source', sourceId, '--apply', '--expect', hash]);
      expect(applied.results[0]).toMatchObject({ applied: 2, skipped: 1, outcomes: { retired: 2, changed_since_preview: 1 } });
      expect(applied.results[0].outcome_items).toContainEqual(expect.objectContaining({ item: `${sourceId}:atoms/2026-01-01/orphan`, outcome: 'changed_since_preview' }));
      expect((await atom(sourceId, 'atoms/2026-01-01/orphan')).deleted).toBe(false);
    }, 60_000);

    test('recovery journey: doctor, preview, apply, doctor, running the printed commands verbatim (DX-O15c)', async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const sourceId = `stale-j-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'A page the user deleted.' }, { sourceId });
      for (let i = 0; i < 30; i++) await putAtom(sourceId, `atoms/2026-01-01/gone-${i}`, { source_slug: 'notes/gone', source_hash: 'cccccccccccccccc' });
      await engine.softDeletePage('notes/gone', { sourceId });
      const before = await computeAtomProvenanceDriftCheck(engine);
      expect(before.status).toBe('warn');
      const printed = before.message.match(/gbrain repair stale-atoms/)![0];
      const preview = await withEnv({ GBRAIN_HOME: home }, async () => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try { await runRepairCommand(engine, [...printed.split(' ').slice(2), '--source', sourceId, '--json']); } finally { console.log = original; }
        return JSON.parse(lines.join('\n')) as RepairJson;
      });
      expect(preview.results[0].residuals).toEqual({ origin_gone: 30, origin_changed: 0 });
      const applied = await repair(preview.results[0].apply_command.split(' ').slice(3));
      expect(applied.results[0].outcomes).toEqual({ retired: 30 });
      const after = await computeAtomProvenanceDriftCheck(engine);
      expect(Number((before.details as Record<string, number>).source_gone) - Number((after.details as Record<string, number>).source_gone)).toBe(30);
    }, 60_000);

    test('an approved set applies only under the source selection it was previewed with', async () => {
      const sourceId = await unmanagedFixture();
      const hash = hashOf(await repair(['--source', sourceId]));
      const refused = await refusal(() => repair(['--apply', '--expect', hash]));
      expect(refused.toJSON()).toMatchObject({ error: 'preview_changed', docs: 'docs/guides/repair.md#preview-changed' });
      expect((await atom(sourceId, 'atoms/2026-01-01/gone')).deleted).toBe(false);
    }, 60_000);

    test('a new preview never resumes the cursor an interrupted apply of an older preview left', async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const sourceId = `stale-r-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const edited = await engine.putPage('notes/edited', { type: 'note', title: 'Edited', compiled_truth: 'The current text.' }, { sourceId });
      await putAtom(sourceId, 'atoms/2026-01-01/current', { source_slug: 'notes/edited', source_hash: edited.content_hash!.slice(0, 16) });
      await putAtom(sourceId, 'atoms/2026-01-01/old-1', { source_slug: 'notes/edited', source_hash: 'aaaaaaaaaaaaaaaa' });
      await putAtom(sourceId, 'atoms/2026-01-01/old-2', { source_slug: 'notes/edited', source_hash: 'aaaaaaaaaaaaaaaa' });
      const first = hashOf(await repair(['--source', sourceId]));
      expect((await repair(['--source', sourceId, '--apply', '--expect', first, '--limit', '1'])).results[0].outcomes).toEqual({ retired: 1 });
      await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'Deleted later.' }, { sourceId });
      await putAtom(sourceId, 'atoms/2026-01-01/gone', { source_slug: 'notes/gone', source_hash: 'cccccccccccccccc' });
      await engine.softDeletePage('notes/gone', { sourceId });
      const second = await repair(['--source', sourceId]);
      expect(second.results[0].listing!.map(entry => entry.class)).toEqual(['origin_gone', 'origin_changed']);
      expect((await repair(['--source', sourceId, '--apply', '--expect', hashOf(second)])).results[0].outcomes).toEqual({ retired: 2 });
      expect((await atom(sourceId, 'atoms/2026-01-01/gone')).deleted).toBe(true);
    }, 60_000);

    async function managedFixture(sourceId: string) {
      const root = join(home, sourceId);
      const slug = 'notes/example';
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      const writeSource = async (body: string) => {
        const written = await engine.putPage(slug, { type: 'source', title: 'Example', compiled_truth: body }, { sourceId });
        mkdirSync(join(root, 'notes'), { recursive: true });
        writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(written, []));
        return written;
      };
      let page = await writeSource('A careful project record at revision one. '.repeat(40));
      await withEnv({ GBRAIN_HOME: home }, async () => { await registerLocalWriter(engine, 'cli'); await claimWorktree(engine, sourceId, root); });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const titles = ['Patience compounds', 'Hire slowly'];
      let calls = 0;
      const chat = async (): Promise<ChatResult> => {
        calls++;
        return { text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Body for ${title}.` }))),
          blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
      };
      const unmanaged = async <T>(fn: () => Promise<T>): Promise<T> => {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
      };
      return {
        root, slug, unmanaged, calls: () => calls,
        extract: () => withEnv({ GBRAIN_HOME: home }, () => runPhaseExtractAtoms(engine, { sourceId, _transcripts: [],
          _pages: [{ slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chat })),
        edit: async (body: string) => { page = await unmanaged(() => writeSource(body)); return page; },
        atoms: () => engine.executeRaw<{ slug: string; deleted: boolean; frontmatter: Record<string, unknown> }>(
          "SELECT slug, deleted_at IS NOT NULL AS deleted, frontmatter FROM pages WHERE source_id=$1 AND type='atom' ORDER BY slug", [sourceId]),
      };
    }

    test('managed: delete the page, repair, restore the page, and extraction re-creates its atoms', async () => {
      const sourceId = `stale-m-${randomUUID().slice(0, 8)}`;
      const f = await managedFixture(sourceId);
      try {
        expect((await f.extract()).status).toBe('ok');
        const before = await f.atoms();
        expect(before.map(row => row.deleted)).toEqual([false, false]);
        await f.unmanaged(() => engine.softDeletePage(f.slug, { sourceId }));
        const preview = await repair(['--source', sourceId]);
        expect(preview.results[0].listing!.map(entry => entry.class)).toEqual(['origin_gone', 'origin_gone']);
        expect((await f.atoms()).map(row => row.deleted)).toEqual([false, false]);
        const applied = await repair(['--source', sourceId, '--apply', '--expect', hashOf(preview)]);
        expect(applied.results[0]).toMatchObject({ applied: 2, outcomes: { retired: 2 } });
        for (const row of await f.atoms()) {
          expect(row).toMatchObject({ deleted: true, frontmatter: { retired_by: 'stale-atoms' } });
          expect(existsSync(join(f.root, `${row.slug}.md`))).toBe(false);
        }
        await f.unmanaged(() => engine.restorePage(f.slug, { sourceId }));
        expect((await discoverExtractablePages(engine, sourceId)).map(item => item.slug)).toEqual([f.slug]);
        expect((await f.extract()).status).toBe('ok');
        expect(f.calls()).toBe(2);
        const after = await f.atoms();
        expect(after.map(row => row.slug)).toEqual(before.map(row => row.slug));
        for (const row of after) {
          expect(row.deleted).toBe(false);
          expect(row.frontmatter).not.toHaveProperty('retired_by');
          expect(existsSync(join(f.root, `${row.slug}.md`))).toBe(true);
        }
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    }, 60_000);

    test('managed: an atom whose file holds an uncoordinated edit reports file_conflict, and a fresh apply retires it once the file is fixed', async () => {
      const sourceId = `stale-f-${randomUUID().slice(0, 8)}`;
      const f = await managedFixture(sourceId);
      try {
        expect((await f.extract()).status).toBe('ok');
        await f.unmanaged(() => engine.softDeletePage(f.slug, { sourceId }));
        const [first] = await f.atoms();
        writeFileSync(join(f.root, `${first.slug}.md`), 'Uncoordinated operator content.');
        const preview = await repair(['--source', sourceId]);
        const blocked = await repair(['--source', sourceId, '--apply', '--expect', hashOf(preview)]);
        expect(blocked.results[0].outcomes).toEqual({ file_conflict: 1, retired: 1 });
        expect((await atom(sourceId, first.slug)).deleted).toBe(false);
        rmSync(join(f.root, `${first.slug}.md`));
        const again = await repair(['--source', sourceId]);
        expect(again.results[0].listing!.map(entry => entry.item)).toEqual([`${sourceId}:${first.slug}`]);
        expect((await repair(['--source', sourceId, '--apply', '--expect', hashOf(again)])).results[0].outcomes).toEqual({ retired: 1 });
        expect((await atom(sourceId, first.slug))).toMatchObject({ deleted: true, frontmatter: { retired_by: 'stale-atoms' } });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    }, 60_000);

    test('managed: atoms of an edited page are stale only once its current text completed an extraction', async () => {
      const sourceId = `stale-c-${randomUUID().slice(0, 8)}`;
      const f = await managedFixture(sourceId);
      try {
        expect((await f.extract()).status).toBe('ok');
        const edited = await f.edit('A careful project record at revision two. '.repeat(40));
        expect((await repair(['--source', sourceId])).results[0].affected).toBe(0);
        const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
        await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms',$1,$2::text::jsonb)`,
          [`pre-fix-${sourceId}`, JSON.stringify([{ sourceId, incarnation, requestId: randomUUID(), kind: 'page', locator: f.slug, pageId: edited.id, contentHash: edited.content_hash }])]);
        const preview = await repair(['--source', sourceId]);
        expect(preview.results[0].listing!.map(entry => entry.class)).toEqual(['origin_changed', 'origin_changed']);
        const applied = await repair(['--source', sourceId, '--apply', '--expect', hashOf(preview)]);
        expect(applied.results[0]).toMatchObject({ applied: 2, outcomes: { retired: 2 } });
        expect((await f.atoms()).every(row => row.deleted && row.frontmatter.retired_by === 'stale-atoms')).toBe(true);
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    }, 60_000);
  });
}

/**
 * D-23 (GBRA-131, #6986): extract_atoms reads a declared `storage.db_only` page from the database, and a db_only
 * page's stale cache file no longer wedges coordinated writes to that page.
 *
 * Protects: on a managed brain whose gbrain.yml declares `meetings/` db_only, (a) a meeting page is extracted and
 * its atoms publish whether its cache file is absent or stale, with the cache bytes left as they were; (b) a
 * coordinated write to the meeting whose cache holds an earlier database state (a version the database already
 * had, left behind by a writer that skipped the cache) publishes and refreshes the cache. A cache holding content
 * the database never had still refuses `source_changed` with both copies kept, and an edited published atom
 * file still refuses, so the drift guard is not loosened for uncoordinated edits.
 * Fails when: the coordinated publication treats a stale db_only cache as an uncoordinated local edit and refuses
 * "The canonical file contains an uncoordinated local edit" (`source_changed` / `file_database_drift`) on every write.
 * Seams: a stub chat model (no paid calls); the real managed coordinator. PGLite always, Postgres when DATABASE_URL
 * is set.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer, waitForWrites } from '../../src/core/persistence/service.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { operations } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const MEETING = 'meetings/2026-04-03-acme-example';
const NOTE = 'notes/acme-example-plan';
const prose = (label: string) => `${label}: the team agreed to measure every launch against clear exit criteria and to review them weekly. `.repeat(12);

function stubChat() {
  const calls: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1];
    calls.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
    const text = JSON.stringify([{ title: `Launch exit criteria ${calls.length}`, body: 'Measure every launch against clear exit criteria.', atom_type: 'insight' }]);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { calls, chat };
}

/**
 * A phase can return while a request it admitted is still publishing: a batch whose atom write was refused returns at that
 * refusal, and its `__managed_atom_complete__` request runs afterwards. Stopping the consumer then races that request, so its
 * requests are waited out first and the rows are read settled.
 */
async function settle(engine: BrainEngine): Promise<void> {
  const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state IN ('queued','running')");
  await waitForWrites(engine, pending, { engine: engine.kind } as GBrainConfig, 60_000);
  await disposePersistenceConsumer(engine);
}

const atomsFrom = (engine: BrainEngine, slug: string) => engine.executeRaw<{ slug: string }>(
  `SELECT slug FROM pages WHERE source_id='default' AND type='atom' AND deleted_at IS NULL AND frontmatter->>'source_slug'=$1`, [slug]);
const item = async (engine: BrainEngine, slug: string) => {
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  return { slug, content: page.compiled_truth, contentHash: page.content_hash! };
};

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-23 extract_atoms on declared db_only pages (${backend})`, () => {
    for (const cache of ['absent', 'stale', 'stale-recorded'] as const) {
      test(`D-23 db_only meeting with its cache file ${cache}: atoms publish from the database copy and the cache is untouched`, async () => {
        let cacheBytes: string | null = null;
        await managedBrain(async ({ engine, root }) => {
          const { calls, chat } = stubChat();
          const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: chat, _transcripts: [] });
          await disposePersistenceConsumer(engine);
          const refusals = await engine.executeRaw<{ error_code: string | null }>(
            "SELECT error_code FROM persistence_requests WHERE source_id='default' AND outcome->>'status' IS DISTINCT FROM 'completed' AND error_code IS NOT NULL");
          expect({ status: result.status, refusals: refusals.map(r => r.error_code) }).toEqual({ status: 'ok', refusals: [] });
          expect(calls.length).toBe(1);
          expect((await atomsFrom(engine, MEETING)).length).toBe(1);
          if (cacheBytes !== null) expect(readFileSync(join(root, `${MEETING}.md`), 'utf8')).toBe(cacheBytes);
        }, { databaseUrl, setup: async ({ engine, root }) => {
          writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
          await engine.putPage(MEETING, { type: 'meeting', title: 'Acme example sync', compiled_truth: prose('current'), timeline: '' }, { sourceId: 'default' });
          if (cache === 'stale-recorded') await engine.executeRaw("UPDATE pages SET source_path=$1 WHERE source_id='default' AND slug=$2", [`${MEETING}.md`, MEETING]);
          if (cache !== 'absent') {
            const path = join(root, `${MEETING}.md`);
            mkdirSync(dirname(path), { recursive: true });
            cacheBytes = `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('older cache')}\n`;
            writeFileSync(path, cacheBytes);
          }
        } });
      }, 180_000);
    }


    test('D-23 a coordinated write to a db_only meeting whose cache holds an earlier database state publishes and refreshes the cache', async () => {
      const older = `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('older cache')}\n`;
      await managedBrain(async ({ engine, root, ctx }) => {
        const snap = (await engine.readPageSnapshot(MEETING, { sourceId: 'default' }))!;
        const outcome = await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: MEETING, expected_revision: snap.revision,
          content: `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('edited in the database')}\n` })
          .then(() => 'published', (error: { code?: string; detail?: string }) => `${error.code}/${error.detail}`);
        await disposePersistenceConsumer(engine);
        expect(outcome).toBe('published');
        expect((await engine.getPage(MEETING, { sourceId: 'default' }))!.compiled_truth).toContain('edited in the database');
        expect(readFileSync(join(root, `${MEETING}.md`), 'utf8')).toContain('edited in the database');
      }, { databaseUrl, setup: async ({ engine, root }) => {
        writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
        await importFromContent(engine, MEETING, older, { sourceId: 'default', noEmbed: true });
        mkdirSync(dirname(join(root, `${MEETING}.md`)), { recursive: true });
        writeFileSync(join(root, `${MEETING}.md`), older);
        await importFromContent(engine, MEETING, `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('current')}\n`, { sourceId: 'default', noEmbed: true });
      } });
    }, 180_000);

    test('D-23 control: a db_only cache holding content the database never had still refuses and both copies stay', async () => {
      const edited = `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('local unpublished edit')}\n`;
      await managedBrain(async ({ engine, root, ctx }) => {
        const snap = (await engine.readPageSnapshot(MEETING, { sourceId: 'default' }))!;
        const outcome = await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: MEETING, expected_revision: snap.revision,
          content: `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('edited in the database')}\n` })
          .then(() => 'published', (error: { code?: string; detail?: string }) => `${error.code}/${error.detail}`);
        await disposePersistenceConsumer(engine);
        expect(outcome).toMatch(/^source_changed\//);
        expect((await engine.readPageSnapshot(MEETING, { sourceId: 'default' }))!.revision).toBe(snap.revision);
        expect(readFileSync(join(root, `${MEETING}.md`), 'utf8')).toBe(edited);
      }, { databaseUrl, setup: async ({ engine, root }) => {
        writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
        await importFromContent(engine, MEETING, `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('current')}\n`, { sourceId: 'default', noEmbed: true });
        mkdirSync(dirname(join(root, `${MEETING}.md`)), { recursive: true });
        writeFileSync(join(root, `${MEETING}.md`), edited);
      } });
    }, 180_000);

    test('D-23 control: an atom whose published file was edited still refuses file_database_drift on re-extraction and the file is untouched', async () => {
      await managedBrain(async ({ engine, root, ctx }) => {
        const sameTitle = (chat: ReturnType<typeof stubChat>['chat']) => async (o: ChatOpts) => {
          const r = await chat(o);
          const text = r.text.replace(/Launch exit criteria \d+/, 'Launch exit criteria 1');
          return { ...r, text, blocks: [{ type: 'text' as const, text }] };
        };
        await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: sameTitle(stubChat().chat), _transcripts: [] });
        await settle(engine);
        const [atom] = await atomsFrom(engine, MEETING);
        const rel = `${atom!.slug}.md`;
        expect(existsSync(join(root, rel))).toBe(true);
        const edited = readFileSync(join(root, rel), 'utf8').replace('Measure every launch', 'HAND-EDIT: measure every launch');
        writeFileSync(join(root, rel), edited);
        const snap = (await engine.readPageSnapshot(MEETING, { sourceId: 'default' }))!;
        await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: MEETING, expected_revision: snap.revision,
          content: `---\ntype: meeting\ntitle: Acme example sync\n---\n\n${prose('edited')}\n` });
        await settle(engine);
        await runPhaseExtractAtoms(engine, { sourceId: 'default', _chat: sameTitle(stubChat().chat), _transcripts: [] });
        await settle(engine);
        // The edited atom refuses; its batch's completion then refuses too (a member did not commit), so nothing is marked done.
        const refusals = await engine.executeRaw<{ slug: string; error_code: string; error_message: string }>(
          "SELECT slug, error_code, error_message FROM persistence_requests WHERE source_id='default' AND error_code IS NOT NULL ORDER BY sequence");
        expect(refusals).toEqual([{ slug: atom!.slug, error_code: 'source_changed', error_message: expect.any(String) },
          { slug: '__managed_atom_complete__', error_code: 'revision_conflict', error_message: 'The atom batch is not fully committed.' }]);
        expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id='default' AND state IN ('queued','running')")).toEqual([]);
        expect(readFileSync(join(root, rel), 'utf8')).toBe(edited);
      }, { databaseUrl, setup: async ({ engine, root }) => {
        writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
        await engine.putPage(MEETING, { type: 'meeting', title: 'Acme example sync', compiled_truth: prose('current'), timeline: '' }, { sourceId: 'default' });
      } });
    }, 180_000);
  });
}

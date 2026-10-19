/**
 * D-22 (GBRA-131).
 * Protects: a legacy digest alone cannot authorize an unversioned body
 * refresh. A database/file divergence must take the normal import path, keeping
 * the exact old body and timeline in page_versions. Compare actual raw bytes,
 * not the body after privacy-fence overlays. Existing hash tests cover only an
 * unchanged body; publication guards cover CAS but not a stale legacy digest
 * with a sealed projection (otherwise projection rebuilding bypasses the bug).
 * Fails when: legacy reconcile overwrites a different stored body without
 * history, compares only the overlaid input, or demotes a segmented page.
 * Seams: no production seam; a transaction proxy lands competing writes immediately
 * before publication, and a real segmented page tests the bounded-body refusal.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { contentHash, contentHashLegacy } from '../../src/core/utils.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { createSegmentedPage, segmentedPageState } from '../helpers/segmented-page.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectOthersUnchanged, pathologicalArms, snapshotItems } from './harness.ts';

const SLUG = 'notes/example';
const raw = (truth = 'Original synthetic body.', timeline = 'Original synthetic timeline.') =>
  `---\ntitle: Example\ntype: note\ntags: [example]\n---\n\n${truth}\n\n<!-- timeline -->\n\n${timeline}\n`;

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine, path: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d22-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        mkdirSync(join(root, 'notes'), { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await engine.putPage('notes/sibling', { type: 'note', title: 'Sibling', compiled_truth: 'Keep sibling bytes.' });
        await run(engine, join(root, `${SLUG}.md`));
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function state(engine: BrainEngine) {
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  return { snapshot, chunks: await engine.getChunks(SLUG, { sourceId: 'default', includeUnsealed: true }),
    versions: await engine.executeRaw<{ compiled_truth: string; timeline: string }>('SELECT * FROM page_versions WHERE page_id=$1 ORDER BY id', [snapshot!.page.id]) };
}

async function legacy(engine: BrainEngine, content: string) {
  const parsed = parseMarkdown(content, `${SLUG}.md`);
  await engine.executeRaw("UPDATE pages SET content_hash=$1, text_projection_revision=knowledge_revision WHERE source_id='default' AND slug=$2", [contentHashLegacy(parsed), SLUG]);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-22 legacy hash and preserved import history (${backend})`, () => {
    for (const field of ['truth', 'timeline', 'both'] as const) {
      test(`${field} differs behind a stale legacy hash: import versions the exact database preimage`, async () => {
        await withBrain(databaseUrl, async (engine, path) => {
          const incoming = raw();
          writeFileSync(path, incoming);
          await importFromFile(engine, path, `${SLUG}.md`, { noEmbed: true, sourceId: 'default' });
          await engine.executeRaw("UPDATE pages SET compiled_truth=$1, timeline=$2 WHERE source_id='default' AND slug=$3",
            [field === 'timeline' ? 'Original synthetic body.' : 'DATABASE-ONLY synthetic edit.', field === 'truth' ? 'Original synthetic timeline.' : 'DATABASE-ONLY timeline edit.', SLUG]);
          await legacy(engine, incoming);
          const before = await state(engine);
          const siblings = await snapshotItems(engine, 'default');
          const result = await importFromFile(engine, path, `${SLUG}.md`, { noEmbed: true, sourceId: 'default' });
          const after = await state(engine);
          expect(readFileSync(path, 'utf8')).toBe(incoming);
          expectOthersUnchanged(siblings, await snapshotItems(engine, 'default'), { changed: [SLUG] });
          expect(result.status).toBe('imported');
          expect(after.snapshot!.revision).not.toBe(before.snapshot!.revision);
          expect(after.snapshot!.page.compiled_truth).toBe('Original synthetic body.');
          expect(after.snapshot!.page.timeline).toBe('Original synthetic timeline.');
          expect(after.versions.slice(0, before.versions.length)).toEqual(before.versions);
          expect(after.versions.slice(before.versions.length)).toMatchObject([{ compiled_truth: before.snapshot!.page.compiled_truth, timeline: before.snapshot!.page.timeline }]);
          expect(after.snapshot!.tags).toEqual(before.snapshot!.tags);
          expect((await importFromFile(engine, path, `${SLUG}.md`, { noEmbed: true, sourceId: 'default' })).status).toBe('skipped');
          expect(await state(engine)).toEqual(after);
        });
      }, 180_000);
    }

    test('agreeing raw body, sanitized NUL and trimmed whitespace: canonical hash upgrade changes no revision, chunks or history', async () => {
      await withBrain(databaseUrl, async (engine, path) => {
        const incoming = raw(' \nOriginal synthetic body.\0\n ');
        writeFileSync(path, incoming);
        await importFromFile(engine, path, `${SLUG}.md`, { noEmbed: true, sourceId: 'default' });
        const stored = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
        await engine.executeRaw('UPDATE pages SET content_hash=$1 WHERE id=$2', [contentHashLegacy(stored), stored.id]);
        const before = await state(engine);
        expect((await importFromFile(engine, path, `${SLUG}.md`, { noEmbed: true, sourceId: 'default' })).status).toBe('skipped');
        const after = await state(engine);
        expect(after.snapshot!.revision).toBe(before.snapshot!.revision);
        expect(after.snapshot!.page.compiled_truth).toBe(stored.compiled_truth);
        expect(after.snapshot!.page.timeline).toBe(stored.timeline);
        expect(after.snapshot!.page.content_hash).toBe(contentHash({ ...stored, tags: ['example'] }));
        expect(after.chunks).toEqual(before.chunks);
        expect(after.versions).toEqual(before.versions);
        expect(readFileSync(path, 'utf8')).toBe(incoming);
      });
    }, 180_000);

    for (const column of ['truth', 'timeline'] as const) {
      test(`raw ${column} lacks a hidden fact restored by privacy overlay: it cannot authorize an unversioned refresh`, async () => {
        await withBrain(databaseUrl, async (engine, path) => {
          const facts = renderFactsTable([{ rowNum: 1, claim: 'A private synthetic claim.', kind: 'fact', confidence: 1,
            visibility: 'private', notability: 'medium', validFrom: '2026-01-01', source: 'manual', active: true }]);
          const incoming = raw();
          const complete = raw(column === 'truth' ? `Original synthetic body.\n\n## Facts\n\n${facts}` : undefined,
            column === 'timeline' ? `Original synthetic timeline.\n\n## Facts\n\n${facts}` : undefined);
          await importFromContent(engine, SLUG, complete, { noEmbed: true, sourceId: 'default' });
          await legacy(engine, complete);
          writeFileSync(path, incoming);
          const before = await state(engine);
          const result = await importFromContent(engine, SLUG, readFileSync(path, 'utf8'), { noEmbed: true, sourceId: 'default', remote: true });
          const after = await state(engine);
          expect(result.status).toBe('imported');
          expect(after.snapshot!.revision).toBe(before.snapshot!.revision);
          expect(after.snapshot!.page.compiled_truth).toBe(before.snapshot!.page.compiled_truth);
          expect(after.snapshot!.page.timeline).toBe(before.snapshot!.page.timeline);
          expect(after.versions.slice(before.versions.length)).toMatchObject([{ compiled_truth: before.snapshot!.page.compiled_truth, timeline: before.snapshot!.page.timeline }]);
          expect(readFileSync(path, 'utf8')).toBe(incoming);
        });
      }, 180_000);
    }

    for (const diverged of [false, true]) {
      test(`concurrent database edit before publication (initially diverged=${diverged}) refuses without losing the winner`, async () => {
        await withBrain(databaseUrl, async (engine, path) => {
          writeFileSync(path, raw());
          await importFromContent(engine, SLUG, raw(), { noEmbed: true, sourceId: 'default' });
          if (diverged) await engine.executeRaw("UPDATE pages SET compiled_truth='Database preparation preimage.' WHERE slug=$1", [SLUG]);
          await legacy(engine, raw());
          let winner: Awaited<ReturnType<typeof state>> | undefined;
          const proxy = new Proxy(engine, { get(target, key) {
            if (key === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>) => {
              if (!winner) {
                const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
                await engine.putPage(SLUG, { type: page.type, title: page.title, frontmatter: page.frontmatter,
                  compiled_truth: 'Concurrent synthetic winner.', timeline: 'Concurrent timeline.' }, { sourceId: 'default' });
                winner = await state(engine);
              }
              return target.transaction(fn);
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
          await expect(importFromContent(proxy, SLUG, readFileSync(path, 'utf8'), { noEmbed: true, sourceId: 'default' })).rejects.toMatchObject({ code: 'revision_conflict' });
          expect(winner).toBeDefined();
          expect(await state(engine)).toEqual(winner!);
          expect(readFileSync(path, 'utf8')).toBe(raw());
        });
      }, 180_000);
    }

    test('database edit after the CAS read but before the row lock cannot be overwritten by legacy refresh', async () => {
      await withBrain(databaseUrl, async (engine, path) => {
        writeFileSync(path, raw());
        await importFromContent(engine, SLUG, raw(), { noEmbed: true, sourceId: 'default' });
        await legacy(engine, raw());
        let winner: Awaited<ReturnType<typeof state>> | undefined;
        const proxy = new Proxy(engine, { get(target, key) {
          if (key === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(new Proxy(tx, {
            get(transaction, member) {
              if (member === 'getPage') return async (...args: Parameters<BrainEngine['getPage']>) => {
                const observed = await transaction.getPage(...args);
                if (!winner && args[0] === SLUG) {
                  await transaction.putPage(SLUG, { type: observed!.type, title: observed!.title, frontmatter: observed!.frontmatter,
                    compiled_truth: 'Winner landed after CAS read.', timeline: 'Winner timeline after CAS read.' }, { sourceId: 'default' });
                  winner = await state(transaction);
                }
                return observed;
              };
              const value = Reflect.get(transaction, member, transaction);
              return typeof value === 'function' ? value.bind(transaction) : value;
            },
          })));
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        await expect(importFromContent(proxy, SLUG, readFileSync(path, 'utf8'), { noEmbed: true, sourceId: 'default' })).rejects.toMatchObject({ code: 'revision_conflict' });
        expect(winner).toBeDefined();
        expect(await state(engine)).toEqual(winner!);
        expect(readFileSync(path, 'utf8')).toBe(raw());
      });
    }, 180_000);

    test('normal versioned import rolls back its preimage, chunks and revision when publication is rejected', async () => {
      await withBrain(databaseUrl, async (engine, path) => {
        await importFromContent(engine, SLUG, raw('Database-only body.'), { noEmbed: true, sourceId: 'default' });
        await legacy(engine, raw());
        writeFileSync(path, raw());
        const before = await state(engine);
        let versioned = false;
        await expect(importFromContent(engine, SLUG, raw(), { noEmbed: true, sourceId: 'default', beforeCommit: async tx => {
          versioned = (await tx.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.snapshot!.page.id])).length === before.versions.length + 1;
          throw new Error('Synthetic publication refused');
        } })).rejects.toThrow('Synthetic publication refused');
        expect(await state(engine)).toEqual(before);
        expect(versioned).toBe(true);
        expect(readFileSync(path, 'utf8')).toBe(raw());
      });
    }, 180_000);

    test('small materialized segmented page at legacy reconcile is held without demotion or a history write', async () => {
      await withBrain(databaseUrl, async (engine, path) => {
        const { id } = await createSegmentedPage(engine, { slug: SLUG, truth: 'Original synthetic body.', timeline: 'Original synthetic timeline.',
          meta: { title: 'Example', type: 'note', frontmatter: {} } });
        await legacy(engine, raw());
        writeFileSync(path, raw());
        const before = await segmentedPageState(engine, id);
        const versions = await engine.executeRaw('SELECT * FROM page_versions WHERE page_id=$1', [id]);
        await expect(importFromContent(engine, SLUG, raw(), { noEmbed: true, sourceId: 'default' })).rejects.toMatchObject({ code: 'page_body_segmented' });
        expect(await segmentedPageState(engine, id)).toEqual(before);
        expect(await engine.executeRaw('SELECT * FROM page_versions WHERE page_id=$1', [id])).toEqual(versions);
        expect(readFileSync(path, 'utf8')).toBe(raw());
      });
    }, 180_000);

    test('segmented page over the whole-body ceiling is held with its manifest and history intact', async () => {
      await withBrain(databaseUrl, async (engine, path) => {
        const { id } = await createSegmentedPage(engine, { slug: SLUG, truth: 'Segmented database-only body.' });
        await engine.executeRaw('UPDATE pages SET body_bytes=$1 WHERE id=$2', [PAGE_MAX_BYTES + 1, id]);
        await legacy(engine, raw());
        writeFileSync(path, raw());
        const before = await segmentedPageState(engine, id);
        const versions = await engine.executeRaw('SELECT * FROM page_versions WHERE page_id=$1', [id]);
        await expect(importFromContent(engine, SLUG, raw(), { noEmbed: true, sourceId: 'default' })).rejects.toMatchObject({ code: 'page_body_segmented' });
        expect(await segmentedPageState(engine, id)).toEqual(before);
        expect(await engine.executeRaw('SELECT * FROM page_versions WHERE page_id=$1', [id])).toEqual(versions);
        expect(readFileSync(path, 'utf8')).toBe(raw());
      });
    }, 180_000);
  });
}

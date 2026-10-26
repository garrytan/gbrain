/**
 * Wave C 1E (spec §5 "doctor"): oversized_pages sizes a segmented page by body_bytes.
 *
 * 1. Protects: a page stored in segments is measured by its stored byte count against the block its streamed import
 *    judges it by (content_sanity.bytes_block, or unset the page ceiling), so a segmented page over a lowered block is
 *    reported like an inline one, and an unset block reports nothing for a page under the ceiling.
 * 2. Fails when: the scan sizes octet_length(compiled_truth), NULL for a segmented page, so the page is never reported
 *    (master), or a segmented page is held to the inline 24 MiB block instead of its own.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { createProgress } from '../../src/core/progress.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { Check } from '../../src/commands/doctor.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { contentSanityEntry } from '../../src/commands/doctor/checks/content-quality.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-oversized-segmented-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_NO_SANITY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const SLUG = 'notes/segmented-oversized';
const brains: Array<{ kind: string; engine: BrainEngine; bytes: number }> = [];
const closers: Array<() => Promise<void>> = [];

function ctx(engine: BrainEngine): DoctorContext {
  return { engine, args: [], jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined,
    progress: createProgress({ mode: 'quiet' }), skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null,
    schemaVersion: 0, connectionFailed: false, tier: 'standard' };
}

const oversized = async (engine: BrainEngine) => ((await contentSanityEntry.run(ctx(engine))) as Check[]).find(c => c.name === 'oversized_pages')!;

beforeAll(async () => {
  await withEnv(env, async () => {
    const all: Array<{ kind: string; engine: BrainEngine }> = [];
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); all.push({ kind: 'pglite', engine: lite });
    closers.push(async () => { await disposePersistenceConsumer(lite); await lite.disconnect(); });
    if (process.env.DATABASE_URL) {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
      all.push({ kind: 'postgres', engine: pg.engine });
      closers.push(async () => { await disposePersistenceConsumer(pg.engine); await pg.close(); });
    }
    for (const { kind, engine } of all) {
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.executeRaw("UPDATE persistence_brain SET enabled=false WHERE singleton=1");
      const page = `---\ntype: note\ntitle: Segmented oversized\n---\n\n${conversationBody(1_500_000, { seed: 11 })}\n`;
      expect(await importFromContent(engine, SLUG, page, { noEmbed: true })).toMatchObject({ status: 'imported' });
      const [row] = await engine.executeRaw<{ body_storage: string; body_bytes: number; frontmatter: Record<string, unknown> }>(
        "SELECT body_storage, body_bytes, frontmatter FROM pages WHERE source_id='default' AND slug=$1", [SLUG]);
      expect(row!.body_storage).toBe('segmented');
      expect(row!.frontmatter.embed_skip).toBeUndefined();
      brains.push({ kind, engine, bytes: Number(row!.body_bytes) });
    }
  });
}, 600_000);

afterAll(async () => {
  await withEnv(env, async () => { for (const close of closers) await close(); });
  rmSync(home, { recursive: true, force: true });
});

describe('oversized_pages sizes a segmented page by body_bytes', () => {
  test('a segmented page over a lowered content_sanity.bytes_block is reported with its stored bytes', async () => withEnv(env, async () => {
    for (const { kind, engine, bytes } of brains) {
      await engine.setConfig('content_sanity.bytes_block', String(bytes - 1));
      try {
        const check = await oversized(engine);
        expect([kind, check.status]).toEqual([kind, 'warn']);
        expect(check.message).toContain(`${SLUG} (${bytes}b, src=default)`);
        expect(check.message).not.toContain('skipped (segmented)');
      } finally { await engine.unsetConfig('content_sanity.bytes_block'); }
    }
  }), 300_000);

  test('with the block unset a segmented page under the page ceiling is checked and not oversized', async () => withEnv(env, async () => {
    for (const { kind, engine } of brains) {
      const check = await oversized(engine);
      expect([kind, check.status]).toEqual([kind, 'ok']);
      expect(check.message).not.toContain('skipped (segmented)');
    }
  }), 300_000);
});

/**
 * Credential-safe re-seal of segmented pages (Wave B, spec 11, reader
 * inventory row 8).
 *
 * 1. Protects: a segmented page whose segments hold a private key (a stored
 *    `pem` region; its body columns are NULL) and whose projection is unsealed
 *    is counted as pending by the credential check and re-sealed by
 *    `resealCredentialProjections` through its segmented projection, with no
 *    chunk carrying the key body.
 * 2. Fails when: the pending scan only matches the inline body columns, so a
 *    segmented page with a key stays withheld and uncounted.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { credentialProjectionPending, resealCredentialProjections } from '../../src/core/page-state/credential-reseal.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-credential-segments-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCexampleNOTREAL0';
const fence = '-'.repeat(5), keyLabel = ['PRIVATE', 'KEY'].join(' ');
const KEY = `${fence}BEGIN ${keyLabel}${fence}\n${Array.from({ length: 12 }, (_, i) => `${KEY_LINE.slice(0, -1)}${i % 10}`).join('\n')}\n${fence}END ${keyLabel}${fence}`;
function filler(tag: string, bytes: number): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## ${tag} ${i}\n\n${`Deployment runbook notes for the staging cluster, step ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const BODY = `---\ntitle: Runbook\ntype: note\n---\n\n# Runbook\n\n${filler('Before', 700_000)}## Old deploy key\n\n${KEY}\n\n${filler('After', 700_000)}`;

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) await engine.setConfig('pages.segmented_storage', 'on');
}), 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

describe('credential re-seal of segmented pages', () => {
  test('a segmented page holding a private key is counted pending and re-sealed from its segments', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'notes/runbook', BODY, { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, 'notes/runbook');
      expect(page.body_storage).toBe('segmented');
      expect(await engine.executeRaw(`SELECT 1 FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL AND protected_regions @> '[{"kind":"pem"}]'::jsonb`, [page.id])).not.toHaveLength(0);
      // What migration v189 does to a page carrying a key: its projection is unsealed until re-chunked.
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [page.id]);
      expect(await credentialProjectionPending(engine, ['default'])).toEqual({ rebuildable: 1, kept: 0 });

      expect(await resealCredentialProjections(engine)).toMatchObject({ resealed: 1, failed: 0, superseded: 0 });
      expect(await credentialProjectionPending(engine, ['default'])).toEqual({ rebuildable: 0, kept: 0 });
      const after = await segmentedPageRow(engine, 'notes/runbook');
      expect(after.text_projection_revision).toBe(after.knowledge_revision);
      expect(await engine.executeRaw(`SELECT 1 FROM content_chunks WHERE page_id=$1 AND strpos(chunk_text,$2)>0`, [page.id, KEY_LINE.slice(0, 40)])).toHaveLength(0);
      expect(await engine.executeRaw('SELECT 1 FROM content_chunks WHERE page_id=$1', [page.id])).not.toHaveLength(0);
    }
  }), 300_000);
});

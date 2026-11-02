/**
 * #8352: a gbrain maintenance re-import that rewrites only gbrain-owned frontmatter (the oversized backfill's
 * size-gate marker, a quarantine clear) keeps an owner note's trust tier (`operator_curated`), so remote readers do not
 * get it quoted (GST-687): the trust trigger leaves those markers out of its content comparison
 * (TRUST_EPHEMERAL_FRONTMATTER_KEYS). An undeclared content write still lowers the tier. PostgreSQL arm:
 * test/postgres-unit-arms.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { asOwner } from './helpers/owner-tier.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runOversizedBackfill } from '../src/core/oversized-backfill.ts';
import { runQuarantine } from '../src/commands/quarantine.ts';
import { isEmbedSkipped } from '../src/core/embed-skip.ts';
import { isQuarantined } from '../src/core/quarantine.ts';

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  let engine: BrainEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
    else {
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      await pglite.initSchema();
      engine = pglite;
      close = () => pglite.disconnect();
    }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  async function withHome<T>(fn: () => Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), 'trust-keep-8352-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_AUDIT_DIR: home }, fn);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  async function tierOf(slug: string): Promise<string | null> {
    const [row] = await engine.executeRaw<{ trust_tier: string | null }>('SELECT trust_tier FROM pages WHERE slug = $1', [slug]);
    return row?.trust_tier ?? null;
  }

  async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const log = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = log; }
  }

  describe(`#8352 maintenance re-imports keep the trust tier (${backend})`, () => {
    test('the oversized backfill clears its size-gate marker on an owner note and the note stays operator_curated', async () => {
      await withHome(async () => {
        const line = 'alice-example and bob-example talked about acme-example plans today.\n';
        await engine.setConfig('content_sanity.bytes_block', '500000');
        await asOwner(engine, tx => importFromContent(tx, 'notes/long-owner', `---\ntype: note\ntitle: Long owner note\n---\n\n${line.repeat(9000)}`, { noEmbed: true }));
        await engine.unsetConfig('content_sanity.bytes_block');
        const before = await engine.getPage('notes/long-owner');
        expect(isEmbedSkipped(before!.frontmatter as Record<string, unknown>)).toBe(true);
        expect(await tierOf('notes/long-owner')).toBe('operator_curated');

        expect(await runOversizedBackfill(engine)).toMatchObject({ candidates: 1, reindexed: 1 });
        const after = await engine.getPage('notes/long-owner');
        expect(isEmbedSkipped(after!.frontmatter as Record<string, unknown>)).toBe(false);
        expect(await tierOf('notes/long-owner')).toBe('operator_curated');
      });
    }, 120_000);

    test('quarantine clear --force on an owner note drops its markers and the note stays operator_curated', async () => {
      await withHome(async () => {
        await asOwner(engine, tx => importFromContent(tx, 'notes/q-owner', '---\ntitle: B\ntype: note\n---\n\nCloudflare Ray ID: y. body.', { noEmbed: true }));
        expect(isQuarantined((await engine.getPage('notes/q-owner'))!.frontmatter as Record<string, unknown>)).toBe(true);
        expect(await tierOf('notes/q-owner')).toBe('operator_curated');

        await quiet(() => runQuarantine(engine, ['clear', 'notes/q-owner', '--force', '--no-embed']));
        expect(isQuarantined((await engine.getPage('notes/q-owner'))!.frontmatter as Record<string, unknown>)).toBe(false);
        expect(await tierOf('notes/q-owner')).toBe('operator_curated');
      });
    });

    test('an undeclared content write still lowers an owner note to unknown', async () => {
      await withHome(async () => {
        await asOwner(engine, tx => importFromContent(tx, 'notes/plain-owner', '---\ntitle: P\ntype: note\n---\n\nThe owner wrote this.', { noEmbed: true }));
        expect(await tierOf('notes/plain-owner')).toBe('operator_curated');
        await importFromContent(engine, 'notes/plain-owner', '---\ntitle: P\ntype: note\n---\n\nSomeone else rewrote this.', { noEmbed: true });
        expect(await tierOf('notes/plain-owner')).toBe('unknown');
      });
    });
  });
}

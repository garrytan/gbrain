/**
 * Existing-brain repair for the credential-safe projection (security wave
 * ENG-2 / DX-9), on PGLite and (with DATABASE_URL) Postgres.
 *
 * Protects: chunks stored before the projection, including a middle chunk that
 * holds private-key body lines and no fence, never reach a local or remote
 * search/query/recall/evidence caller once the upgrade's schema migration has
 * run: not before the re-chunk completes, not after an interrupted re-chunk,
 * not after it. The re-chunk runs with no provider calls, leaves pages without
 * a key untouched, and doctor reports what is still pending. The chunker and
 * safe-fence versions stay pinned, so no brain-wide re-chunk is triggered.
 * Regression it catches: a global fence bump, a pending set that a retrieval
 * path ignores, or a repair that re-embeds without consent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput, SearchResult } from '../../src/core/types.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../../src/core/chunkers/recursive.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../src/core/search/safe-chunks.ts';
import { resealSafeChunks } from '../../src/core/page-state/projections.ts';
import { hydrateChunks } from '../../src/core/search/two-pass.ts';
import { credentialProjectionPendingCheck } from '../../src/commands/doctor/checks/credential-projection.ts';
import { v0_60_31, __setTestEngineOverride } from '../../src/commands/migrations/v0_60_31.ts';
import * as gateway from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { getFtsLanguage } from '../../src/core/fts-language.ts';
import { readContentChunksEmbeddingDim } from '../../src/core/embedding-dim-check.ts';

const SOURCE = 'credential-reseal-fixture';

const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const KEY_LINES = KEY.split('\n').filter(line => /^[A-Za-z0-9+/=]{16,}$/.test(line));
const FRAGMENTS = KEY_LINES.flatMap(line => {
  const out: string[] = [];
  for (let i = 0; i + 24 <= line.length; i += 8) out.push(line.slice(i, i + 24));
  return out;
});
const leaked = (payload: unknown) => FRAGMENTS.filter(fragment => JSON.stringify(payload).includes(fragment));

const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i} word`).join(' ');
const keyPage = (tag: string) => `## ${tag} deploy notes\n\n${words(60, tag)}\n\nThe service key:\n\n${KEY}\n## Rotation\n\n${words(60, `${tag}tail`)}\n`;
const CONTROL_BODY = `## Kestrel notes\n\n${words(60, 'kestrel')}\n`;

/** Chunks as the pre-projection chunker cut them: the middle one is key body only, with no fence. */
function legacyChunks(body: string, dims: number): ChunkInput[] {
  const lines = body.split('\n');
  const begin = lines.findIndex(l => l.startsWith('-----BEGIN'));
  const end = lines.findIndex(l => l.startsWith('-----END'));
  const vector = () => new Float32Array(dims).fill(0.01);
  return [lines.slice(0, begin + 4), lines.slice(begin + 4, end - 3), lines.slice(end - 3)].map((part, i) => ({
    chunk_index: i, chunk_text: part.join('\n').trim(), chunk_source: 'compiled_truth', embedding: vector(),
  }));
}

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: credential-safe re-chunk of existing pages`, () => {
    let engine: BrainEngine;
    /** A search term only the fenceless middle chunk holds, as the keyword index tokenizes it. */
    let BODY_TOKEN = '';
    const op = (name: string) => operations.find(o => o.name === name)!;
    const ctxOf = (remote: boolean): OperationContext => ({
      engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote, sourceId: SOURCE,
      emitResponseMeta: () => {},
    } as OperationContext);

    async function retrieve(remote: boolean, query: string): Promise<unknown[]> {
      return [
        await op('search').handler(ctxOf(remote), { query }),
        await op('query').handler(ctxOf(remote), { query, expand: false }),
        await op('recall').handler(ctxOf(remote), { query }),
        await op('search').handler(ctxOf(remote), { query, return_unit: 'window', return_window: 1, token_budget: 400 }),
        await op('search').handler(ctxOf(remote), { query, return_unit: 'page', token_budget: 2000 }),
      ];
    }

    async function expectNoFragment(stage: string): Promise<void> {
      for (const remote of [false, true]) {
        for (const query of [BODY_TOKEN, 'alpha3 deploy', 'beta3 deploy']) {
          expect(leaked(await retrieve(remote, query)), `${stage} remote=${remote} ${query}`).toEqual([]);
        }
      }
    }

    const slugsFound = async (query: string) =>
      ((await op('search').handler(ctxOf(false), { query })) as SearchResult[]).map(r => r.slug);

    beforeAll(async () => {
      gateway.configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [SOURCE]);
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SOURCE]);
      await engine.setConfig('search.mcp_keyword_only', 'true');
      const dims = (await readContentChunksEmbeddingDim(engine)).dims ?? LEGACY_EMBEDDING_CONFIG.embedding_dimensions;
      for (const [slug, body] of [['notes/alpha-key', keyPage('alpha')], ['notes/beta-key', keyPage('beta')], ['notes/kestrel', CONTROL_BODY]] as const) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: SOURCE });
        await installFixtureChunks(engine, slug, body === CONTROL_BODY
          ? [{ chunk_index: 0, chunk_text: body.trim(), chunk_source: 'compiled_truth' }]
          : legacyChunks(body, dims), { sourceId: SOURCE });
      }
      const [token] = await engine.executeRaw<{ lexeme: string }>(`SELECT t.lexeme FROM unnest(to_tsvector('${getFtsLanguage()}', $1::text)) t
        WHERE t.lexeme ~ '^[a-z0-9]{12,}$' AND t.lexeme ~ '[0-9]' ORDER BY length(t.lexeme) DESC, t.lexeme LIMIT 1`, [legacyChunks(keyPage('alpha'), dims)[1].chunk_text]);
      BODY_TOKEN = token.lexeme;
    }, 180_000);

    afterAll(async () => {
      __setTestEngineOverride(null);
      if (engine) {
        await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [SOURCE]);
        await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE]);
        await engine.disconnect();
      }
      gateway.resetGateway();
    }, 60_000);

    test('chunker and safe-fence versions are pinned (no brain-wide re-chunk)', () => {
      expect(MARKDOWN_CHUNKER_VERSION).toBe(4);
      expect(SAFE_FENCE_CHUNKER_VERSION).toBe(4);
    });

    test('the seeded legacy brain leaks a fenceless fragment before the upgrade', async () => {
      expect(leaked(await op('search').handler(ctxOf(false), { query: BODY_TOKEN })).length).toBeGreaterThan(0);
    });

    test('after the schema migration, before the re-chunk: withheld for every caller, doctor reports it', async () => {
      await engine.setConfig('version', '186');
      await runMigrations(engine);
      await expectNoFragment('pending');
      expect(await slugsFound('kestrel3')).toContain('notes/kestrel');
      const legacyIds = (await engine.getChunks('notes/alpha-key', { sourceId: SOURCE, includeUnsealed: true })).map(c => c.id);
      expect(await hydrateChunks(engine, legacyIds), 'local code-walk hydration').toEqual([]);
      const check = await credentialProjectionPendingCheck(engine, [SOURCE]);
      expect(check.status).toBe('warn');
      expect(check.details).toMatchObject({ pages_pending: 2, kept_pages: 0 });
      expect(check.message).toContain('gbrain apply-migrations --yes');
    });

    test('after an interrupted re-chunk: the finished page is clean and visible, the rest stay withheld', async () => {
      expect(await resealSafeChunks(engine, 'notes/alpha-key', SOURCE)).not.toBeNull();
      await expectNoFragment('interrupted');
      expect(await slugsFound('alpha3')).toContain('notes/alpha-key');
      expect(await slugsFound('beta3')).not.toContain('notes/beta-key');
      expect((await credentialProjectionPendingCheck(engine, [SOURCE])).details).toMatchObject({ pages_pending: 1 });
    });

    test('the orchestrated migration finishes provider-free and is idempotent', async () => {
      __setTestEngineOverride(engine);
      const result = await v0_60_31.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
      expect(result.status).toBe('complete');
      expect(result.phases[0]).toMatchObject({ name: 'credential_projection', status: 'complete' });
      expect(result.phases[0].detail).toContain('1 page(s) re-chunked without provider calls');
      await expectNoFragment('repaired');
      expect(await slugsFound('beta3')).toContain('notes/beta-key');
      expect(await slugsFound('kestrel3')).toContain('notes/kestrel');
      const chunks = await engine.getChunks('notes/beta-key', { sourceId: SOURCE, includeUnsealed: true });
      expect(leaked(chunks.map(c => c.chunk_text))).toEqual([]);
      expect(chunks.some(c => c.embedded_at === null)).toBe(true);
      expect((await credentialProjectionPendingCheck(engine, [SOURCE])).status).toBe('ok');
      const rerun = await v0_60_31.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
      expect(rerun.phases[0].detail).toContain('0 page(s) re-chunked');
    });
  });
}

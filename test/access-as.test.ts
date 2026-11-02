/**
 * GBRA-218 A1 identity: the caller-access composition a local `--as <member>`
 * runs under (src/cli/main.ts runSharedOperation), in process on a repo-less
 * brain (in-memory PGLite; Postgres too when DATABASE_URL is set).
 *
 * 1. Protects: a trusted local read under
 *    withCallerAccess({ identity, applyRemoteReadPolicy: true, hidePrivate: true })
 *    sees exactly the member view (readers applied, visibility: private
 *    hidden, escape hatches relax nothing), while ctx.remote stays false, so
 *    upload confinement keeps its local meaning.
 * 2. Fails when: --as reads past readers, a hatch widens an --as preview,
 *    readers relax visibility: private, or --as flips upload confinement.
 * 3. Existing coverage: test/access-as.serial.test.ts (the CLI seam).
 * 4. Real seams: dispatchToolCall with remote:false, the file_upload handler.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withCallerAccess, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, memberIdentity } from '../src/core/access/members.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const SRC = 'source-a';
const PAGES = {
  alice: { slug: 'notes/alice-plan', canary: 'canaryinasalice', fm: 'readable_by: [alice-example]' },
  quiet: { slug: 'notes/quiet-plan', canary: 'canaryinasquiet', fm: 'readable_by: [alice-example]\nvisibility: private' },
  open: { slug: 'notes/open-plan', canary: 'canaryinasopen', fm: '' },
} as const;

for (const kind of testBackends()) {
  describe(`local --as composition (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function asMember<T>(member: string | null, fn: () => Promise<T>): Promise<T> {
      if (!member) return fn();
      const { identity } = await memberIdentity(engine, member);
      return withCallerAccess({ identity, applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] }, fn);
    }
    async function seen(member: string | null): Promise<string[]> {
      const out: string[] = [];
      for (const [key, page] of Object.entries(PAGES)) {
        const got = await asMember(member, () => dispatchToolCall(engine, 'get_page', { slug: page.slug }, { remote: false, sourceId: SRC }));
        const found = await asMember(member, () => dispatchToolCall(engine, 'search', { query: page.canary, match: 'keyword', fields: 'full' }, { remote: false, sourceId: SRC }));
        if ([got, found].some(r => r.content.map(c => c.text).join('\n').includes(page.canary))) out.push(key);
      }
      return out.sort();
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const p of Object.values(PAGES)) {
        await importFromContent(engine, p.slug, `---\ntype: note\ntitle: ${p.slug}\n${p.fm}\n---\n# Plan\n\nPlanning notes ${p.canary}.`, { sourceId: SRC });
      }
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('the plain local CLI reads everything; --as alice sees her page; --as bob sees only the open page', async () => {
      expect(await seen(null)).toEqual(['alice', 'open', 'quiet']);
      expect(await seen('alice-example')).toEqual(['alice', 'open']);
      expect(await seen('bob-example')).toEqual(['open']);
    }, 60_000);

    test('escape hatches relax nothing under --as, and readers never relax visibility: private', async () => {
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        expect(await seen('bob-example')).toEqual(['open']);
        expect(await seen('alice-example')).toEqual(['alice', 'open']);
      });
      await engine.setConfig('search.remote_private_pages', 'visible');
      __resetPrivateVisibilityCacheForTests();
      try {
        expect(await seen('bob-example')).toEqual(['open']);
      } finally {
        await engine.setConfig('search.remote_private_pages', 'hidden');
        __resetPrivateVisibilityCacheForTests();
      }
    }, 60_000);

    test('--as keeps ctx.remote false: upload confinement keeps its local meaning', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gb-as-upload-'));
      const file = join(dir, 'outside-cwd.txt');
      writeFileSync(file, 'upload probe');
      const upload = operations.find(o => o.name === 'file_upload')!;
      const ctx = (remote: boolean, identity?: string[]) => ({
        engine, config: {}, remote, dryRun: false, sourceId: SRC, logger: { info() {}, warn() {}, error() {} },
        ...(identity ? { accessIdentity: identity, applyRemoteReadPolicy: true } : {}),
      }) as unknown as OperationContext;
      const failure = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };
      try {
        const { identity } = await memberIdentity(engine, 'bob-example');
        const asBob = await asMember('bob-example', () => failure(() => upload.handler(ctx(false, identity), { path: file })));
        const local = await failure(() => upload.handler(ctx(false), { path: file }));
        const remote = await failure(() => upload.handler(ctx(true), { path: file }));
        expect(asBob).toBe(local);
        expect(asBob).toBe('storage_error');
        expect(remote).not.toBe('storage_error');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

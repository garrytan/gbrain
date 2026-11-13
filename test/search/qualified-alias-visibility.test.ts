/**
 * search.qualified_aliases under the read policy, on a repo-less brain
 * (in-memory PGLite; Postgres too when DATABASE_URL is set, and through
 * test/e2e/qualified-alias-visibility-postgres.test.ts).
 *
 * 1. Protects: the qualified alias hop counts and injects only pages the
 *    caller can read. A page restricted by `readable_by` or marked
 *    `visibility: private` never hops in, never suppresses a readable
 *    claimant of the same phrase, and so its existence never shows.
 * 2. Fails when: the claimant read skips the caller's member access or the
 *    private predicate, or the inject path skips the private re-check.
 * 3. Real seams: engine.resolveAliases and getPage under withCallerAccess,
 *    and the MCP `search` op with remote: true.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { applyAliasHop } from '../../src/core/search/hybrid.ts';
import { withCallerAccess, __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { addMember, memberIdentity } from '../../src/core/access/members.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const SRC = 'source-a';
const Q = 'status of the acme widget project today';

for (const kind of testBackends()) {
  describe(`qualified alias hop under the read policy (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function put(slug: string, fm: string, alias = 'acme widget project') {
      await importFromContent(engine, slug, `---\ntype: project\ntitle: Codename Falcon\naliases: [${alias}]\n${fm}\n---\nQuarterly figures.`, { sourceId: SRC, noEmbed: true });
    }
    async function hop(member: string | null, excludePrivate = true): Promise<string[]> {
      const run = () => applyAliasHop(engine, [], Q, { sourceId: SRC, excludePrivate, qualified: true });
      if (!member) return (await run()).map(r => r.slug);
      const { identity } = await memberIdentity(engine, member);
      return (await withCallerAccess({ identity, applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] }, run)).map(r => r.slug);
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
    }, 120_000);

    afterAll(async () => {
      resetGateway();
      await close?.();
    }, 60_000);

    test('a sole claimant readable only by bob never hops in for alice', async () => {
      await put('projects/falcon-bob', 'readable_by: [bob-example]');
      expect(await hop('bob-example')).toEqual(['projects/falcon-bob']);
      expect(await hop('alice-example')).toEqual([]);
    }, 60_000);

    test('a claimant alice cannot read does not suppress the one she can', async () => {
      await put('projects/falcon-open', '');
      expect(await hop('alice-example')).toEqual(['projects/falcon-open']);
      expect(await hop('bob-example')).toEqual([]);
    }, 60_000);

    test('a visibility: private claimant is skipped under excludePrivate', async () => {
      await put('projects/falcon-bob', 'readable_by: [bob-example]', 'beta gamma widget');
      await put('projects/falcon-private', 'visibility: private');
      expect(await hop(null)).toEqual(['projects/falcon-open']);
      expect(await hop(null, false)).toEqual([]);
    }, 60_000);

    test('MCP search with remote: true injects only the readable claimant', async () => {
      await importFromContent(engine, 'notes/status-log', '---\ntype: note\ntitle: Status log\n---\nStatus of the week, written today.', { sourceId: SRC, noEmbed: true });
      const before = await dispatchToolCall(engine, 'search', { query: Q }, { remote: true, transport: 'http', sourceId: SRC } as never);
      expect(before.content.map(c => c.text ?? '').join('\n')).not.toContain('projects/falcon-open');
      await engine.setConfig('search.qualified_aliases', 'true');
      try {
        const r = await dispatchToolCall(engine, 'search', { query: Q }, { remote: true, transport: 'http', sourceId: SRC } as never);
        const rows = JSON.parse(r.content[0].text!) as Array<{ slug: string }>;
        const text = r.content.map(c => c.text ?? '').join('\n');
        expect(rows[0]?.slug).toBe('projects/falcon-open');
        expect(text).not.toContain('projects/falcon-private');
        expect(text).not.toContain('projects/falcon-bob');
      } finally {
        await engine.setConfig('search.qualified_aliases', 'false');
      }
    }, 60_000);
  });
}

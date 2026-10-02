/**
 * Ambient recall must not widen what remote search returns (gbrain-evals
 * N8-1 / N8-2). volunteer_context resolved a `visibility: private` page by
 * title, alias or surname and returned its title and body synopsis to a
 * remote caller, and the per-turn hook block (assembleTurnContext, turn
 * mode) injected the same page. Remote callers on every transport, the
 * turn block and the reflex resolver's default now hide private and
 * derived-private pages; the trusted local caller still sees them.
 * PGLite always; Postgres when a safe DATABASE_URL is set and in the E2E
 * lane through test/e2e/reflex-private-visibility-postgres.test.ts.
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { assembleTurnContext } from '../src/core/context/turn-context.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { extractCandidatesFromWindow } from '../src/core/context/entity-salience.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) {
describe(`reflex private visibility (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const config = { engine: kind } as any;

  const put = (slug: string, content: string) =>
    dispatchToolCall(engine, 'put_page', { slug, content }, { remote: false, sourceId: 'default', config });

  const page = (title: string, type: string, visibility: string | null, aliases: string[], body: string) =>
    `---\ntype: ${type}\ntitle: ${JSON.stringify(title)}\n${visibility ? `visibility: ${visibility}\n` : ''}aliases: ${JSON.stringify(aliases)}\n---\n\n${body}\n`;

  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else {
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      await pglite.initSchema();
      engine = pglite;
      close = () => pglite.disconnect();
    }
    __resetPrivateVisibilityCacheForTests();
    await put('people/zora-quillfeather', page('Zora Quillfeather', 'person', 'private', ['Zee'], 'Zora Quillfeather is a confidential contact, code PRIVMARK1.'));
    await put('atoms/velmora-claim', page('Velmora Claim', 'atom', null, [], 'Velmora Claim derived ATOMMARK1 statement.'));
    await put('companies/harbor-logistics', page('Harbor Logistics', 'company', 'world', ['Harbor'], 'Harbor Logistics is a shipping partner WORLDMARK1.'));
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  const HIDDEN = ['people/zora-quillfeather', 'PRIVMARK1', 'Zora Quillfeather', 'atoms/velmora-claim', 'ATOMMARK1'];

  const WINDOWS = [
    'user: Lunch with Zora Quillfeather and Harbor Logistics went well.',
    'user: Zee called about Harbor Logistics again.',
    'user: Did Quillfeather reply? Harbor Logistics is waiting.',
    'user: The Velmora Claim came up while reviewing Harbor Logistics.',
  ];

  const remoteCallers = {
    stdio: { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config },
    http: {
      remote: true,
      transport: 'http' as const,
      sourceId: 'default',
      takesHoldersAllowList: ['world'],
      config,
      auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default'] } as any,
    },
  };

  async function volunteer(window: string, opts: Record<string, unknown>) {
    const r = await dispatchToolCall(engine, 'volunteer_context', { window, min_confidence: 0.5 }, opts as any);
    expect(r.isError).toBeFalsy();
    return r.content[0].text;
  }

  describe(`volunteer_context hides private pages from remote callers`, () => {
    for (const [name, opts] of Object.entries(remoteCallers)) {
      for (const window of WINDOWS) {
        test(`${name}: ${window}`, async () => {
          const text = await volunteer(window, opts);
          for (const marker of HIDDEN) expect(text).not.toContain(marker);
          expect(text).toContain('companies/harbor-logistics');
        });
      }

      test(`${name}: remote search agrees (no private hit)`, async () => {
        const r = await dispatchToolCall(engine, 'search', { query: 'Zora Quillfeather' }, opts as any);
        expect(r.content[0].text).not.toContain('PRIVMARK1');
      });
    }

    test('local trusted caller still sees the private page', async () => {
      const text = await volunteer(WINDOWS[0], { remote: false, sourceId: 'default', config });
      expect(text).toContain('people/zora-quillfeather');
      expect(text).toContain('companies/harbor-logistics');
    });
  });

  describe(`turn-context block never injects private pages`, () => {
    for (const window of WINDOWS) {
      test(window, async () => {
        const r = await assembleTurnContext(engine, {
          sourceId: 'default',
          window: [{ role: 'user', text: window.replace(/^user: /, '') }],
        });
        for (const marker of HIDDEN) expect(r.text).not.toContain(marker);
        expect(r.text).toContain('companies/harbor-logistics');
      });
    }
  });

  describe(`resolveEntitiesToPointers is world-only unless a caller widens it`, () => {
    const candidates = () =>
      extractCandidatesFromWindow([{ role: 'user', text: 'Zora Quillfeather met Harbor Logistics.' }]);

    test('default excludes private pages (the ambient reflex and IPC resolve posture)', async () => {
      const block = await resolveEntitiesToPointers(engine, 'default', candidates());
      expect(block?.pointers.map((p) => p.slug)).toEqual(['companies/harbor-logistics']);
    });

    test('excludePrivate: false (trusted local) keeps the private page', async () => {
      const block = await resolveEntitiesToPointers(engine, 'default', candidates(), { excludePrivate: false });
      expect(block?.pointers.map((p) => p.slug).sort()).toEqual(['companies/harbor-logistics', 'people/zora-quillfeather']);
    });
  });
});
}

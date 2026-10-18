/**
 * Evidence delivery leak canaries — the release gate for `return_unit`
 * (plan amendment 2): delivered evidence never exceeds what `get_page`
 * returns to the same caller, on PGLite and Postgres, through local ops,
 * MCP stdio and MCP HTTP, with public presence controls proving the
 * expansion really delivered neighbor and whole-page text.
 *
 * Canaries: private fact rows, takes (even for trusted local callers:
 * the body is sanitized whole for every caller), withdrawn fact rows, a malformed
 * protected tail, timeline fact rows, a `visibility: private` page, a derived
 * atom (private by default), and the same slug in an ungranted source. The
 * mid-flight cases re-authorize stale hits: grant revocation, a page turning
 * private, and an edit between ranking and expansion. A conversation page
 * (with its own protected rows) covers the implied `auto` default, which
 * delivers conversation pages whole.
 *
 * The subset invariant runs every op and unit, including the auto default,
 * over ranked hits AND over frozen hits naming every chunk of every page, so
 * anchor paths ranking rarely reaches (a fenced-code chunk as the best hit,
 * whose synthesized `[Lang] fence.ts:N-M` header is not page text) are
 * exercised. It once ran only ranked `search` page-unit hits on a corpus with
 * no fenced code, so that header slipped through.
 *
 * Postgres arm runs when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { renderFactsTable, FACTS_FENCE_BEGIN } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { AUTO_PACKINGS, EVIDENCE_CUT_MARKER, assembleEvidenceForHits, countEvidenceTokens, deliverEvidence, type EvidencePlan } from '../../src/core/search/evidence-delivery.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { createManagedFixtureSource, withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';
import { fixtureDiagnostic, toolDiagnostic } from '../helpers/fixture-diagnostics.ts';
import { withEnv } from '../helpers/with-env.ts';

const BOUND = 'evd-bound';
const FOREIGN = 'evd-foreign';
const UNITS = ['window', 'section', 'page', 'auto'] as const;
const CODE_HEADER_LINE = /^\[[^\]]+\] fence\.\w+:\d+-\d+ /m;

// Public presence controls (must appear in page-unit evidence).
const PRESENT = ['PUBLICMARKALPHA', 'PUBLICMARKOMEGA', 'WORLDFACTKESTREL', 'TIMELINEPUBLICWREN', 'TIMELINEWORLDFINCH'];
// Must appear when the auto default (or page) delivers the conversation whole.
const CONVERSATION_PRESENT = ['SESSIONOPENERHERON', 'SESSIONCLOSERHERON'];
// Protected for remote callers.
const REMOTE_CANARIES = ['PRIVATEPAGECANARY', 'ATOMCANARY'];
// Protected for every caller (whole-body sanitizing) plus other-source text.
const ALWAYS_CANARIES = ['FACTCANARYPRIVATE', 'TAKECANARYPRIVATE', 'WITHDRAWNCANARY', 'MALFORMEDTAILCANARY', 'TIMELINEFACTCANARY', 'FOREIGNSOURCECANARY', 'EDITSECRETCANARY', 'SESSIONTAKECANARY'];

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Heron field notes paragraph ${i} describing ordinary public observations of the marsh and the weather that day.`).join('\n\n');

function heronPage(): string {
  const facts = renderFactsTable([
    { rowNum: 1, claim: 'WORLDFACTKESTREL heron nests near the pier', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: 'FACTCANARYPRIVATE heron owner home address', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
    { rowNum: 3, claim: 'WITHDRAWNCANARY heron old claim', kind: 'fact', confidence: 1, visibility: 'world', notability: 'low', active: false, forgotten: true, context: 'forgotten: user asked to remove' },
  ]);
  const timelineFacts = renderFactsTable([
    { rowNum: 1, claim: 'TIMELINEWORLDFINCH heron migration date', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: 'TIMELINEFACTCANARY heron private timeline fact', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
  ]);
  return `---\ntitle: heron\ntype: note\n---\n\nheron PUBLICMARKALPHA introduction.\n\n## Field notes\n\n${filler(30)}\n\n${facts}\n\n${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | TAKECANARYPRIVATE heron opinion | take | owner-example | 0.8 | | |\n${TAKES_FENCE_END}\n\n## Closing\n\n${filler(8)}\n\nheron PUBLICMARKOMEGA closing line.\n\n<!-- timeline -->\n\n- 2026-01-01 heron TIMELINEPUBLICWREN sighting\n\n${timelineFacts}\n\n${TAKES_FENCE_BEGIN}\nMALFORMEDTAILCANARY heron unterminated protected tail\n`;
}

function heronSession(): string {
  const turns = Array.from({ length: 24 }, (_, i) =>
    `**user:** heron question ${i} about the marsh walk ${'and the tide tables '.repeat(8)}\n\n**assistant:** heron answer ${i} ${'about the nesting season '.repeat(8)}`).join('\n\n');
  return `---\ntitle: heron session\ntype: conversation\n---\n\n**user:** SESSIONOPENERHERON heron opening question.\n\n${turns}\n\n${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | SESSIONTAKECANARY heron session opinion | take | owner-example | 0.8 | | |\n${TAKES_FENCE_END}\n\n**assistant:** SESSIONCLOSERHERON heron closing answer.\n`;
}

const codeFn = (name: string) => `export function ${name}(heron: number): number {\n${Array.from({ length: 12 }, (_, i) => `  const step${i} = heron * ${i + 2} + ${name.length};`).join('\n')}\n  return heron;\n}`;

const FIXTURES: Array<[slug: string, source: string, body: string]> = [
  ['notes/heron', BOUND, heronPage()],
  ['notes/heron-private', BOUND, `---\ntitle: heron private\ntype: note\nvisibility: private\n---\n\nheron PRIVATEPAGECANARY private memo.\n`],
  ['atoms/heron-atom', BOUND, `---\ntitle: heron atom\ntype: atom\nsource_slug: notes/heron\n---\n\nheron ATOMCANARY derived atom.\n`],
  ['notes/heron-edit', BOUND, `---\ntitle: heron edit\ntype: note\n---\n\nheron editable page. EDITSECRETCANARY line to be removed.\n\n${filler(6)}\n`],
  ['notes/heron', FOREIGN, `---\ntitle: heron\ntype: note\n---\n\nheron FOREIGNSOURCECANARY other source page.\n\n${filler(4)}\n`],
  ['conversations/sessions/heron-session', BOUND, heronSession()],
  ['notes/heron-code', BOUND, `---\ntitle: heron code\ntype: note\n---\n\nThe heron tracker module.\n\n\`\`\`ts\n${codeFn('heronAlpha')}\n\n${codeFn('heronBeta')}\n\n${codeFn('heronGamma')}\n\`\`\`\n\nheron tracker closing note.\n`],
];

const backends = process.env.DATABASE_URL ? ['pglite', 'postgres'] as const : ['pglite'] as const;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    child.kill('SIGTERM');
  });
}

function assertNoLeak(label: string, payload: unknown, canaries: string[]): void {
  const text = JSON.stringify(payload);
  for (const c of canaries) expect(text.includes(c), `${label} leaked ${c}`).toBe(false);
}

function assertPresent(label: string, payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const c of PRESENT) expect(text.includes(c), `${label} missing presence control ${c}`).toBe(true);
}

for (const backend of backends) describe(`evidence delivery leak canaries (${backend})`, () => {
  let home: string;
  let env: Record<string, string>;
  let engine: BrainEngine;
  let config: GBrainConfig;
  let cleanupPostgres: (() => Promise<void>) | undefined;
  let provider: ReturnType<typeof Bun.serve>;
  const token = `gbrain_${randomBytes(32).toString('hex')}`;

  async function mutate<T>(run: () => Promise<T>): Promise<T> {
    await engine.connect(config);
    try { return await run(); } finally { await engine.disconnect(); }
  }

  async function importPage(slug: string, source: string, body: string) {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await importFromContent(engine, slug, body, {
        sourceId: source, noEmbed: false,
        prepare: async prepared => {
          await withManagedFixtureWrite(engine, [source], tx => prepared.apply(tx));
          return prepared.result;
        },
      });
    });
  }

  function ctxOf(remote: boolean, meta?: { value?: Record<string, unknown> }): OperationContext {
    return {
      engine: engine as never, config: config as never, logger: console as never, dryRun: false, remote, sourceId: BOUND,
      emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval' && meta) meta.value = value as Record<string, unknown>; },
    } as OperationContext;
  }

  async function withStdio(run: (client: Client) => Promise<void>) {
    const transport = new StdioClientTransport({
      command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve'],
      cwd: process.cwd(), env: { ...env, GBRAIN_SOURCE: BOUND }, stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
    const client = new Client({ name: 'evidence-leak', version: '1' });
    try {
      await client.connect(transport);
      await run(client);
    } catch (error) {
      console.error(fixtureDiagnostic('stdio fixture', stderr, [token]));
      throw error;
    } finally {
      await client.close();
      await transport.close();
    }
  }

  async function withHttp(run: (client: Client) => Promise<void>) {
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--http',
      '--bind', '127.0.0.1', '--port', String(port), '--public-url', base, '--suppress-bootstrap-token'],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
    const client = new Client({ name: 'evidence-leak-http', version: '1' });
    try {
      let ready = false;
      for (let i = 0; i < 120; i++) {
        try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
        if (ready || child.exitCode !== null) break;
        await Bun.sleep(250);
      }
      expect(ready, fixtureDiagnostic('HTTP startup', stderr, [token])).toBe(true);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      await run(client);
    } catch (error) {
      console.error(fixtureDiagnostic('HTTP fixture', stderr, [token]));
      throw error;
    } finally {
      await client.close();
      await stop(child);
    }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-evidence-leak-'));
    provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (request.method === 'GET') return Response.json({ data: [{ id: 'text-embedding-3-small' }] });
      const body = await request.json() as { input: string | string[] };
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: 'text-embedding-3-small', data: input.map((text, index) => {
        const embedding = Array(1536).fill(0);
        embedding[text.toLowerCase().includes('heron') ? 0 : 1] = 1;
        return { object: 'embedding', index, embedding };
      }), usage: { prompt_tokens: 1, total_tokens: 1 } });
    } });
    env = keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined,
      GBRAIN_SCHEMA_PACK: 'gbrain-base-v2', GBRAIN_SWEEP: '0',
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_RETRY_CONNECT: '1',
      OPENAI_API_KEY: 'synthetic-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    });
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env });
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      cleanupPostgres = isolated.close;
      config = { engine: 'postgres', database_url: isolated.databaseUrl };
    } else {
      config = { engine: 'pglite', database_path: join(home, 'db') };
      engine = new PGLiteEngine();
      await engine.connect(config);
      await engine.initSchema();
    }
    config = { ...config, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 };
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
    await createManagedFixtureSource(engine, BOUND, { federated: false });
    await createManagedFixtureSource(engine, FOREIGN, { federated: false });
    for (const [slug, source, body] of FIXTURES) await importPage(slug, source, body);
    await engine.executeRaw(`INSERT INTO access_tokens (name, token_hash, permissions, scopes) VALUES ($1, $2, $3::text::jsonb, $4::text[])`,
      ['evidence-read', createHash('sha256').update(token).digest('hex'), JSON.stringify({ source_id: BOUND, takes_holders: ['world'] }), ['read']]);
    const rows = await engine.executeRaw<{ slug: string; ready: boolean; chunker_version: number }>(
      'SELECT slug, knowledge_revision = text_projection_revision AS ready, chunker_version FROM pages');
    expect(rows.every(row => row.ready && row.chunker_version >= 4), JSON.stringify(rows)).toBe(true);
    // The canaries really are in the stored bodies, and get_page shows the
    // presence controls to a remote caller (the invariant's reference).
    const stored = await engine.executeRaw<{ body: string }>(`SELECT compiled_truth || timeline AS body FROM pages WHERE slug = 'notes/heron' AND source_id = $1`, [BOUND]);
    for (const c of ['FACTCANARYPRIVATE', 'TAKECANARYPRIVATE', 'TIMELINEFACTCANARY', 'MALFORMEDTAILCANARY']) expect(stored[0].body).toContain(c);
    const page = await operations.find(o => o.name === 'get_page')!.handler(ctxOf(true), { slug: 'notes/heron' });
    for (const c of PRESENT) expect(JSON.stringify(page)).toContain(c);
    await engine.disconnect();
  }, 180_000);

  afterAll(async () => {
    await engine?.disconnect().catch(() => {});
    await cleanupPostgres?.();
    provider?.stop(true);
    resetGateway();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('local ops (trusted and untrusted) deliver presence controls and no canaries', async () => {
    await mutate(async () => {
      for (const remote of [false, true]) {
        const canaries = remote ? [...ALWAYS_CANARIES.filter(c => c !== 'EDITSECRETCANARY'), ...REMOTE_CANARIES] : ALWAYS_CANARIES.filter(c => c !== 'EDITSECRETCANARY');
        for (const unit of [...UNITS, undefined]) {
          const meta: { value?: Record<string, unknown> } = {};
          const search = await operations.find(o => o.name === 'search')!.handler(ctxOf(remote, meta), { query: 'heron', return_unit: unit, token_budget: 32000, source_id: BOUND, limit: 50 });
          assertNoLeak(`local remote=${remote} search ${unit}`, search, canaries);
          expect(meta.value?.delivery, `delivery meta for ${unit}`).toBeDefined();
          if (unit === 'page') assertPresent(`local remote=${remote} search page`, search);
          if (unit === 'page' || unit === 'auto' || unit === undefined) {
            for (const c of CONVERSATION_PRESENT) expect(JSON.stringify(search), `${unit} remote=${remote} missing ${c}`).toContain(c);
          }
          const query = await operations.find(o => o.name === 'query')!.handler(ctxOf(remote), { query: 'heron', return_unit: unit, token_budget: 32000, source_id: BOUND, expand: false });
          assertNoLeak(`local remote=${remote} query ${unit}`, query, canaries);
          const recall = await operations.find(o => o.name === 'recall')!.handler(ctxOf(remote), { query: 'heron', return_unit: unit, ...(unit ? { budget_tokens: 32000 } : {}), source_id: BOUND });
          assertNoLeak(`local remote=${remote} recall ${unit}`, recall, canaries);
          const hits = (search as SearchResult[]).map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id }));
          const assembled = await operations.find(o => o.name === 'assemble_evidence')!.handler(ctxOf(remote), {
            hits: [...hits, { source_id: FOREIGN, slug: 'notes/heron', chunk_id: 0 }], return_unit: unit ?? 'auto', token_budget: 32000,
          });
          assertNoLeak(`local remote=${remote} assemble ${unit}`, assembled, remote ? canaries : canaries.filter(c => c !== 'FOREIGNSOURCECANARY'));
        }
        if (!remote) {
          const priv = await operations.find(o => o.name === 'search')!.handler(ctxOf(false), { query: 'heron PRIVATEPAGECANARY', return_unit: 'page', source_id: BOUND });
          expect(JSON.stringify(priv)).toContain('PRIVATEPAGECANARY');
        }
      }
    });
  }, 120_000);

  test('delivered text is a subset of get_page for the same caller, for every op, unit and anchor', async () => {
    await mutate(async () => {
      const allChunks = await engine.executeRaw<{ slug: string; id: number; chunk_source: string }>(
        `SELECT p.slug, cc.id, cc.chunk_source FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.source_id = $1 ORDER BY p.slug, cc.chunk_index`, [BOUND]);
      expect(allChunks.some(c => c.chunk_source === 'fenced_code')).toBe(true);
      let checked = 0;
      for (const remote of [false, true]) {
        const refs = new Map<string, { content: string; lines: Set<string> } | null>();
        const reference = async (slug: string) => {
          if (!refs.has(slug)) {
            try {
              const page = await operations.find(o => o.name === 'get_page')!.handler(ctxOf(remote), { slug, source_id: BOUND, include_content: true }) as { content: string };
              refs.set(slug, { content: page.content, lines: new Set(page.content.split('\n').map(l => l.trim())) });
            } catch { refs.set(slug, null); }
          }
          return refs.get(slug)!;
        };
        const check = async (label: string, unit: string, rows: Array<{ slug: string; chunk_text?: string; chunk?: string; delivered?: { unit: string; truncated: boolean; reason?: string; fallback_reason?: string } }>) => {
          for (const row of rows) {
            const text = row.chunk_text ?? row.chunk ?? '';
            // auto's unchanged rows are the chunk response itself (raw chunk text), not delivered evidence.
            if (!row.delivered || row.delivered.reason === 'not_conversation' || row.delivered.reason === 'conversation_over_budget') continue;
            const ref = await reference(row.slug);
            expect(ref, `${label}: ${row.slug} delivered but not readable via get_page`).not.toBeNull();
            expect(text, `${label}: ${row.slug} carries a code-chunk header`).not.toMatch(CODE_HEADER_LINE);
            if (unit === 'page') expect(row.delivered?.fallback_reason, `${label}: ${row.slug} fell back to a chunk`).toBeUndefined();
            const whole = row.delivered?.unit === 'page' && !row.delivered.truncated;
            const body = text.endsWith(EVIDENCE_CUT_MARKER) ? text.slice(0, -EVIDENCE_CUT_MARKER.length) : text;
            for (const segment of body.split('\n\n[…]\n\n')) {
              for (const line of segment.split('\n')) {
                const t = line.trim();
                if (!t) continue;
                if (whole) expect(ref!.lines.has(t), `${label}: ${row.slug} page line is not a get_page line: ${t.slice(0, 80)}`).toBe(true);
                else expect(ref!.content.includes(t), `${label}: ${row.slug} delivered line not in get_page: ${t.slice(0, 80)}`).toBe(true);
              }
            }
            checked++;
          }
        };
        for (const unit of [...UNITS, undefined]) {
          const label = `remote=${remote} ${unit ?? 'default'}`;
          const search = await operations.find(o => o.name === 'search')!.handler(ctxOf(remote), { query: 'heron', return_unit: unit, token_budget: 32000, source_id: BOUND, limit: 50 }) as SearchResult[];
          await check(`${label} search`, unit ?? 'auto', search);
          const query = await operations.find(o => o.name === 'query')!.handler(ctxOf(remote), { query: 'heron tracker', return_unit: unit, source_id: BOUND, expand: false }) as SearchResult[];
          await check(`${label} query`, unit ?? 'auto', query);
          const recall = await operations.find(o => o.name === 'recall')!.handler(ctxOf(remote), { query: 'heron', return_unit: unit, ...(unit ? { budget_tokens: 32000 } : {}), source_id: BOUND }) as { results: Array<{ slug: string; chunk: string }> };
          await check(`${label} recall`, unit ?? 'auto', recall.results);
          for (const chunk of allChunks) {
            const assembled = await operations.find(o => o.name === 'assemble_evidence')!.handler(ctxOf(remote), {
              hits: [{ source_id: BOUND, slug: chunk.slug, chunk_id: chunk.id }], return_unit: unit ?? 'auto', token_budget: 32000,
            }) as { results: SearchResult[] };
            await check(`${label} assemble ${chunk.slug}#${chunk.id} (${chunk.chunk_source})`, unit ?? 'auto', assembled.results);
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    });
  }, 180_000);

  test('explicit budgets under every packing: no canaries, no cross-source or private text, a subset of get_page, within the budget', async () => {
    await mutate(async () => {
      const recount = (rows: SearchResult[]) => rows.reduce((n, r) => n + countEvidenceTokens(r.title ?? '') + countEvidenceTokens(r.chunk_text), 0);
      try {
        for (const packing of AUTO_PACKINGS.filter(p => p !== 'off')) {
          await engine.setConfig('search.auto_packing', packing);
          for (const remote of [false, true]) {
            const canaries = remote ? [...ALWAYS_CANARIES.filter(c => c !== 'EDITSECRETCANARY'), ...REMOTE_CANARIES] : ALWAYS_CANARIES.filter(c => c !== 'EDITSECRETCANARY');
            const reference = new Map<string, string | null>();
            const readable = async (slug: string) => {
              if (!reference.has(slug)) {
                try {
                  const page = await operations.find(o => o.name === 'get_page')!.handler(ctxOf(remote), { slug, source_id: BOUND, include_content: true }) as { content: string };
                  reference.set(slug, page.content);
                } catch { reference.set(slug, null); }
              }
              return reference.get(slug)!;
            };
            for (const budget of [64, 400, 3000]) {
              const label = `${packing} remote=${remote} @${budget}`;
              const search = await operations.find(o => o.name === 'search')!.handler(ctxOf(remote), { query: 'heron', token_budget: budget, source_id: BOUND, limit: 50, fields: 'full' }) as SearchResult[];
              const query = await operations.find(o => o.name === 'query')!.handler(ctxOf(remote), { query: 'heron', return_unit: 'auto', token_budget: budget, source_id: BOUND, expand: false, fields: 'full' }) as SearchResult[];
              const recall = await operations.find(o => o.name === 'recall')!.handler(ctxOf(remote), { query: 'heron', return_unit: 'auto', budget_tokens: budget, source_id: BOUND });
              // Frozen hits name the same slug in an ungranted source, and a page this caller cannot read.
              const frozen = [...search.map(h => ({ source_id: h.source_id!, slug: h.slug, chunk_id: h.chunk_id })), { source_id: FOREIGN, slug: 'notes/heron', chunk_id: 0 }];
              const assembled = await assembleEvidenceForHits(engine, { hits: frozen, return_unit: 'auto', budget_tokens: budget, auto_packing: packing, caller: { remote, sourceId: BOUND } });
              for (const [name, payload] of [['search', search], ['query', query], ['recall', recall], ['assemble', assembled]] as const) assertNoLeak(`${label} ${name}`, payload, canaries);
              expect(assembled.unresolved, label).toContain(frozen.length - 1);
              for (const rows of [search, query, assembled.results as SearchResult[]]) {
                expect(recount(rows), label).toBeLessThanOrEqual(budget);
                for (const row of rows) {
                  const ref = await readable(row.slug);
                  expect(ref, `${label}: ${row.slug} delivered but not readable via get_page`).not.toBeNull();
                  if (row.delivered?.reason === 'not_conversation') continue;
                  const body = row.chunk_text.endsWith(EVIDENCE_CUT_MARKER) ? row.chunk_text.slice(0, -EVIDENCE_CUT_MARKER.length) : row.chunk_text;
                  for (const line of body.split('\n\n[…]\n\n').flatMap(seg => seg.split('\n'))) {
                    if (line.trim()) expect(ref!.includes(line.trim()), `${label}: ${row.slug} line not in get_page: ${line.slice(0, 80)}`).toBe(true);
                  }
                }
              }
            }
          }
        }
      } finally {
        await engine.executeRaw(`DELETE FROM config WHERE key = 'search.auto_packing'`);
      }
    });
  }, 180_000);

  test('stdio and HTTP transports deliver presence controls and no canaries', async () => {
    const canaries = [...ALWAYS_CANARIES.filter(c => c !== 'EDITSECRETCANARY'), ...REMOTE_CANARIES];
    const verify = async (client: Client) => {
      for (const unit of UNITS) {
        for (const [name, args] of [
          ['search', { query: 'heron', return_unit: unit, token_budget: 32000, limit: 50 }],
          ['query', { query: 'heron', return_unit: unit, token_budget: 32000, expand: false }],
          ['recall', { query: 'heron', return_unit: unit, budget_tokens: 32000 }],
        ] as const) {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, toolDiagnostic(name, result)).not.toBe(true);
          assertNoLeak(`${name} ${unit}`, result, canaries);
          if (name === 'search') {
            expect((result._meta?.retrieval as { delivery?: unknown })?.delivery).toBeDefined();
            if (unit === 'page') assertPresent(`${name} page`, result);
          }
        }
        const rows = JSON.parse(((await client.callTool({ name: 'search', arguments: { query: 'heron', limit: 50 } })).content as Array<{ text: string }>)[0].text) as SearchResult[];
        const assembled = await client.callTool({ name: 'assemble_evidence', arguments: {
          hits: [...rows.map(r => ({ source_id: r.source_id, slug: r.slug, chunk_id: r.chunk_id })), { source_id: FOREIGN, slug: 'notes/heron', chunk_id: 0 }],
          return_unit: unit, token_budget: 32000,
        } });
        expect(assembled.isError, toolDiagnostic('assemble_evidence', assembled)).not.toBe(true);
        assertNoLeak(`assemble ${unit}`, assembled, canaries);
        if (unit === 'page') assertPresent('assemble page', assembled);
      }
    };
    await withStdio(verify);
    await withHttp(verify);
  }, 180_000);

  test('stale hits are re-authorized: grant revocation, private flip and mid-flight edit', async () => {
    const plan: EvidencePlan = { requestedUnit: 'page', unit: 'page', window: 1, budgetTokens: 32000, explicitUnit: true, budgetExplicit: false, packing: 'cap_only' };
    await mutate(async () => {
      // Revocation: hits ranked under a two-source grant, expanded after the grant narrowed.
      const wide = await operations.find(o => o.name === 'search')!.handler({ ...ctxOf(false), sourceId: BOUND }, { query: 'heron', source_id: '__all__', limit: 50 }) as SearchResult[];
      expect(wide.some(h => h.source_id === FOREIGN)).toBe(true);
      const revoked = await deliverEvidence(engine, wide, plan, { sourceIds: [BOUND], excludePrivate: true, requireSafeChunks: true });
      assertNoLeak('revoked', revoked.results, ['FOREIGNSOURCECANARY', ...REMOTE_CANARIES]);
      expect(revoked.delivery.dropped_reasons.not_readable).toBeGreaterThan(0);

    });
    // Mid-flight edit: the secret line is removed after ranking.
    const staleHits = await mutate(async () =>
      await operations.find(o => o.name === 'search')!.handler(ctxOf(false), { query: 'heron editable', source_id: BOUND, limit: 50 }) as SearchResult[]);
    const edited = staleHits.filter(h => h.slug === 'notes/heron-edit');
    expect(JSON.stringify(edited)).toContain('EDITSECRETCANARY');
    await mutate(async () => {
      await importPage('notes/heron-edit', BOUND, `---\ntitle: heron edit\ntype: note\n---\n\nheron editable page. EDITEDPUBLICLINE replaced.\n\n${filler(6)}\n`);
      const after = await deliverEvidence(engine, edited, plan, { sourceId: BOUND, excludePrivate: false, requireSafeChunks: false });
      assertNoLeak('mid-flight edit', after.results, ['EDITSECRETCANARY']);
      expect(JSON.stringify(after.results)).toContain('EDITEDPUBLICLINE');
      // Private flip between ranking and expansion.
      const hits = await operations.find(o => o.name === 'search')!.handler(ctxOf(true), { query: 'heron editable EDITEDPUBLICLINE', source_id: BOUND, limit: 50, fields: 'full' }) as SearchResult[];
      const editHit = hits.filter(h => h.slug === 'notes/heron-edit');
      expect(editHit.length).toBeGreaterThan(0);
      await importPage('notes/heron-edit', BOUND, `---\ntitle: heron edit\ntype: note\nvisibility: private\n---\n\nheron editable page. EDITEDPUBLICLINE replaced.\n\n${filler(6)}\n`);
      const flipped = await deliverEvidence(engine, editHit, plan, { sourceId: BOUND, excludePrivate: true, requireSafeChunks: true });
      expect(flipped.results).toEqual([]);
      expect(flipped.delivery.dropped_reasons).toEqual({ not_readable: 1 });
      const trusted = await deliverEvidence(engine, editHit, plan, { sourceId: BOUND, excludePrivate: false, requireSafeChunks: false });
      expect(trusted.results).toHaveLength(1);
    });
  }, 120_000);

  test('the fixture canaries are protected content, not absent content', () => {
    expect(heronPage()).toContain(FACTS_FENCE_BEGIN);
    expect(heronSession()).toContain(TAKES_FENCE_BEGIN);
    for (const c of [...ALWAYS_CANARIES.filter(c => !['FOREIGNSOURCECANARY', 'EDITSECRETCANARY'].includes(c))]) expect(heronPage() + heronSession()).toContain(c);
  });
});

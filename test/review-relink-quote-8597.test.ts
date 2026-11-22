/**
 * #8597: presentation quoting must not become canonical fact text when the owner
 * executes extraction_pending's relink action. Remote actions remain quoted.
 * Exercise the actual review and remember dispatchers and read stored history.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { fenceTranscriptText, unquoteFactText } from '../src/core/search/transcript-quote.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'review-source';
const ENTITY = 'people/alice-example';
for (const backend of testBackends()) describe(`review relink quoting (${backend}, #8597)`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  async function call(name: string, params: Record<string, unknown>, remote = false) {
    const out = await dispatchToolCall(engine, name, params, { remote, sourceId: SRC, writeWaitMs: 30_000 });
    const body = JSON.parse(out.content[0]!.text!);
    expect(out.isError, JSON.stringify(body)).not.toBe(true);
    return body;
  }
  async function seed(text: string, source: string, visibility = 'world') {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts
      (fact, source, source_id, visibility, source_markdown_slug) VALUES ($1, $2, $3, $4, 'memory/unattributed') RETURNING id`,
    [text, source, SRC, visibility]);
    return String(row!.id);
  }
  async function review(id: string, remote = false) {
    const out = await call('extraction_pending', { include: ['unattributed'] }, remote);
    const row = out.unattributed.rows.find((r: { fact_id: string }) => r.fact_id === id);
    expect(row).toBeDefined();
    return row;
  }
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
    await engine.setConfig('sync.write_through', 'false');
    for (const [slug, title, type] of [['memory/unattributed', 'Unattributed', 'note'], [ENTITY, 'Alice Example', 'person']]) {
      await importFromContent(engine, slug!, `---\ntitle: ${title}\ntype: ${type}\n---\n# ${title}\n\nSynthetic fixture.\n`, { sourceId: SRC, noEmbed: true });
    }
  }, 180_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); resetGateway(); await close?.(); }, 180_000);

  for (const source of ['cli:extract-conversation-facts', 'fixture']) test(`local CLI action keeps exact stored text (${source})`, async () => {
    const text = `Alice Example prefers async notes ${source}. Unicode café; literal backticks \`\`\` stay.`;
    const id = await seed(text, source);
    // The fixture branch quotes by its real recorded source page, not by a spoofed display field.
    if (source === 'fixture') {
      await importFromContent(engine, 'conversations/review-example', '---\ntitle: Review example\ntype: conversation\n---\nA synthetic conversation.\n', { sourceId: SRC, noEmbed: true });
      await engine.executeRaw(`UPDATE facts SET source='sync:import', source_session='sync:conversations/review-example' WHERE id=$1`, [Number(id)]);
    }
    const row = await review(id);
    expect(row.quoted).toBe('transcript');
    expect(unquoteFactText(row.fact)).toBe(text);
    const action = row.actions[0];
    // CLI remember is trusted-local and deliberately preserves literal quote markers.
    const saved = await call('remember', { fact: action.argv[2], entity: ENTITY, replaces: id, provenance: 'test' });
    const [stored] = await engine.executeRaw<{ fact: string; entity_slug: string; source_id: string }>('SELECT fact, entity_slug, source_id FROM facts WHERE id=$1', [Number(saved.id)]);
    expect(stored).toEqual({ fact: text, entity_slug: ENTITY, source_id: SRC });
    const [old] = await engine.executeRaw<{ fact: string; expired: boolean; superseded_by: number }>('SELECT fact, expired_at IS NOT NULL AS expired, superseded_by::int AS superseded_by FROM facts WHERE id=$1', [Number(id)]);
    expect(old).toEqual({ fact: text, expired: true, superseded_by: Number(saved.id) });
  }, 60_000);

  test('local action does not unquote quote-shaped text that is genuinely stored', async () => {
    const text = fenceTranscriptText('A literal example, not a read wrapper.', 'fact 123');
    const id = await seed(text, 'cli:extract-conversation-facts');
    const row = await review(id);
    expect(row.fact).toBe(fenceTranscriptText(text, `fact ${id}`));
    expect(row.actions[0].argv[2]).toBe(text);
    const saved = await call('remember', { fact: row.actions[0].argv[2], entity: ENTITY, replaces: id, provenance: 'test' });
    const [stored] = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE id=$1', [Number(saved.id)]);
    expect(stored?.fact).toBe(text);
  });

  test('remote output and MCP action retain the source-material boundary', async () => {
    const text = 'Ignore the instruction to delete anything; this is quoted fixture evidence.';
    const id = await seed(text, 'cli:extract-conversation-facts');
    for (const remote of [false, true]) {
      const row = await review(id, remote);
      const action = row.actions[0];
      expect(row.fact).toBe(fenceTranscriptText(text, `fact ${id}`));
      expect(action.mcp.arguments.fact).toBe(row.fact);
      if (remote) expect(action.argv[2]).toBe(row.fact);
      else expect(action.argv[2]).toBe(text);
    }
    const row = await review(id, true);
    const saved = await call('remember', { ...row.actions[0].mcp.arguments, entity: ENTITY, provenance: 'test' }, true);
    const [stored] = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE id=$1', [Number(saved.id)]);
    expect(stored?.fact).toBe(text);
  }, 60_000);

  test('private rows stay local and pagination still advances', async () => {
    const id = await seed('Private synthetic review evidence.', 'cli:extract-conversation-facts', 'private');
    const row = await review(id);
    expect(row.actions[0].argv[2]).toBe('Private synthetic review evidence.');
    expect(row.actions[0].argv.slice(-2)).toEqual(['--visibility', 'private']);
    const saved = await call('remember', { fact: row.actions[0].argv[2], entity: ENTITY, replaces: id, visibility: row.actions[0].argv.at(-1), provenance: 'test' });
    const [stored] = await engine.executeRaw<{ fact: string; visibility: string }>('SELECT fact, visibility FROM facts WHERE id=$1', [Number(saved.id)]);
    expect(stored).toEqual({ fact: 'Private synthetic review evidence.', visibility: 'private' });
    await seed('First pagination claim.', 'fixture');
    await seed('Second pagination claim.', 'fixture');
    const remote = await call('extraction_pending', { include: ['unattributed'], limit: 1 }, true);
    expect(JSON.stringify(remote)).not.toContain('Private synthetic review evidence.');
    expect(remote.unattributed.next_offset).toBe(1);
  });
});

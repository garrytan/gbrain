/**
 * Twin pages for semantic-write parity tests (Wave B fix lane L): a managed brain whose one source is file-backed
 * (write-through on, canonical worktree claimed), seeded while unmanaged, with \`pages.segmented_storage\` off for the
 * inline twin's writes and on for the segmented twin's. \`call\` runs one verb as an MCP tool call on the local writer
 * with the switch the target was written under; \`view\` is everything a semantic write can change on a page, with
 * the slug and seed-time stamps made neutral so twins compare equal.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../../src/core/markdown.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';
import { withEnv } from './with-env.ts';

const line = (i: number) => '- ' + String(i).padStart(8, '0') + ' acme-example journal line with enough text to fill a segment quickly\n';
const body = (bytes: number) => Array.from({ length: Math.ceil(bytes / line(0).length) }, (_, i) => line(i)).join('');
/** A person page of about \`bytes\` body bytes with one timeline entry; twins share title and body. */
export const twinPage = (bytes: number) => '---\ntype: person\ntitle: Twin Example\n---\n\n# Twin Example\n\n' + body(bytes) + '\n<!-- timeline -->\n- **2026-10-01** | manual — first entry\n';
/** The file gbrain itself renders for twinPage(bytes), so a write that re-renders it changes only what the write changes. */
const canonical = (slug: string, bytes: number) => { const parsed = parseMarkdown(twinPage(bytes), slug + '.md'); return serializePageToMarkdown(parsed as never, parsed.tags); };
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };

export interface TwinSeed {
  setSwitch(on: boolean): Promise<void>;
  /** A put_page through the coordinator (it writes the canonical file). */
  put(slug: string, bytes: number): Promise<void>;
  /** The canonical file written first, then imported from it (a page over 4 MiB, streamed when segmented). */
  imported(slug: string, bytes: number): Promise<void>;
}

export interface TwinBrain {
  engine: BrainEngine;
  sourceId: string;
  root: string;
  cli: LocalRegistration;
  env(): Record<string, string>;
  setSwitch(on: boolean): Promise<void>;
  /** The extraction model's next reply (extract_facts). */
  setChatReply(reply: string): void;
  call(name: string, params: Record<string, unknown>, target?: string): Promise<Record<string, any>>;
  view(slug: string): Promise<Record<string, unknown>>;
  hits(term: string): Promise<string[]>;
  storageOf(slug: string): Promise<string>;
  close(): Promise<void>;
}

export async function openTwinBrain(kind: 'pglite' | 'postgres', inlineSlugs: readonly string[], seed: (s: TwinSeed) => Promise<void>): Promise<TwinBrain> {
  let chatReply = '{"facts":[]}';
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: chatReply, blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  let engine: BrainEngine;
  let closeEngine: () => Promise<void>;
  if (kind === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; closeEngine = pg.close;
  } else {
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
    engine = lite; closeEngine = () => lite.disconnect();
  }
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-segmented-twins-'));
  const root = join(dir, 'brain'); mkdirSync(join(root, 'people'), { recursive: true });
  const sourceId = 'twins-' + kind;
  const env = () => ({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') });
  const setSwitch = (on: boolean) => engine.setConfig('pages.segmented_storage', on ? 'on' : 'off');
  const cli = await withEnv(env(), async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await engine.setConfig('sync.write_through', 'true');
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('mentions.auto_link', 'off');
    await claimWorktree(engine, sourceId, root);
    const ctx = { engine, sourceId, remote: false as const, config: { engine: kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await seed({ setSwitch,
      put: async (slug, bytes) => { await submitPageMutation(ctx as never, { operation: 'put_page', params: { slug, content: twinPage(bytes), request_id: randomUUID() } }); },
      imported: async (slug, bytes) => {
        writeFileSync(join(root, slug + '.md'), canonical(slug, bytes));
        expect(await importFromFile(engine, join(root, slug + '.md'), slug + '.md', { sourceId, noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
      } });
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return registerLocalWriter(engine, 'cli');
  });
  const cleanRows = (rows: Array<Record<string, unknown>>) => rows.map(row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !/(^id$|_id$|_at$|^valid_from$|^embedding|slug|^source_session$|^created|^updated|^write_origin$)/.test(key))));
  return {
    engine, sourceId, root, cli, env, setSwitch,
    setChatReply: reply => { chatReply = reply; },
    call: async (name, params, target = String(params.slug)) => {
      await setSwitch(!inlineSlugs.includes(target));
      const request = { request_id: randomUUID(), ...params };
      return withEnv(env(), async () => {
        // A write still pending after the reply's wait (a page near 24 MiB on PGLite) is replayed with the same request_id until it settles.
        for (let replay = 0; ; replay++) {
          const response = await withVerifiedLocalRegistration(engine, cli, () => dispatchToolCall(engine, name, request, {
            remote: false, config: { engine: kind }, sourceId, logger: { info() {}, warn() {}, error() {} } }));
          const out = JSON.parse((response.content[0] as { text: string }).text) as Record<string, any>;
          if (out.code !== 'write_pending' || replay >= 20) return out;
        }
      });
    },
    view: async slug => {
      const [row] = await engine.executeRaw<Record<string, any>>(
        'SELECT id, body_storage, content_hash, frontmatter, compiled_truth, timeline FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      const id = Number(row!.id);
      const stored = row!.body_storage === 'segmented' ? await materializeSegmentedBody(engine, id, sourceId) : { compiled_truth: row!.compiled_truth, timeline: row!.timeline };
      const neutral = (text: string) => text.split(slug).join('<slug>').replace(/ingested_at: '[^']*'/, "ingested_at: '<seeded>'");
      return {
        body: stored, frontmatter: { ...row!.frontmatter, ...(row!.frontmatter?.ingested_at ? { ingested_at: '<seeded>' } : {}) },
        tags: (await engine.readPageSnapshot(slug, { sourceId }))!.tags, content_hash: row!.content_hash,
        timeline: cleanRows(await engine.executeRaw('SELECT * FROM timeline_entries WHERE page_id=$1 ORDER BY date, summary', [id])),
        takes: cleanRows(await engine.executeRaw('SELECT * FROM takes WHERE page_id=$1 ORDER BY row_num', [id])),
        facts: cleanRows(await engine.executeRaw('SELECT * FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num', [sourceId, slug])),
        file: existsSync(join(root, slug + '.md')) ? neutral(readFileSync(join(root, slug + '.md'), 'utf8')) : null,
      };
    },
    hits: async term => [...new Set((await engine.searchKeyword(term, { limit: 50 })).map(r => r.slug))].sort(),
    storageOf: async slug => (await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.body_storage,
    close: async () => {
      __setChatTransportForTests(null); __setEmbedTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await closeEngine();
      resetGateway();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

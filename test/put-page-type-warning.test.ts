/**
 * #5880 — put_page warns (never rejects) when its explicit page type is not
 * declared by the write source's active schema pack. Pre-fix an ordinary
 * put_page (MCP, `foresights put`, `foresights call put_page`) stored any type
 * silently, while capture rejected it and subagent writes normalized it.
 * The committed result now carries `type_warning` (stable code, cause, fix,
 * docs) and the caller's logger gets the same line; the page is still
 * stored as written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-5880-'));
const put = operations.find((o) => o.name === 'put_page')!;
let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
});

function ctxWithLog(remote: boolean, warns: string[]): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const, embedding_disabled: true },
    logger: { info: () => {}, warn: (m: string) => { warns.push(m); }, error: () => {} },
    dryRun: false,
    remote,
    sourceId: 'default',
  } as OperationContext;
}

const putPage = (ctx: OperationContext, slug: string, type: string) =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, () => put.handler(ctx, {
    slug,
    content: `---\ntype: ${type}\ntitle: Example\n---\n\nBody text.`,
  })) as Promise<Record<string, any>>;

describe('#5880 put_page undeclared type warning', () => {
  test('trusted local write: stored as-is, result + logger carry page_type_undeclared', async () => {
    const warns: string[] = [];
    const result = await putPage(ctxWithLog(false, warns), 'notes/undeclared-local', 'meeting-transcript');
    expect(result.type_warning).toMatchObject({
      code: 'page_type_undeclared',
      type: 'meeting-transcript',
      pack: 'gbrain-base-v2',
      docs: 'docs/architecture/schema-packs.md#undeclared-page-types',
    });
    expect(result.type_warning.fix).toContain('foresights schema add-type meeting-transcript');
    expect(warns.some((w) => w.includes('page_type_undeclared') && w.includes('meeting-transcript'))).toBe(true);
    const [row] = await engine.executeRaw<{ type: string }>(`SELECT type FROM pages WHERE slug = 'notes/undeclared-local'`);
    expect(row.type).toBe('meeting-transcript');
  });

  test('remote (MCP) write gets the same warning', async () => {
    const result = await putPage(ctxWithLog(true, []), 'notes/undeclared-remote', 'banana');
    expect(result.type_warning?.code).toBe('page_type_undeclared');
  });

  test('declared types and aliases do not warn', async () => {
    const warns: string[] = [];
    const declared = await putPage(ctxWithLog(false, warns), 'notes/declared', 'note');
    const alias = await putPage(ctxWithLog(false, warns), 'notes/alias', 'memo');
    expect(declared.type_warning).toBeUndefined();
    expect(alias.type_warning).toBeUndefined();
    expect(warns.filter((w) => w.includes('page_type_undeclared'))).toEqual([]);
  });
});

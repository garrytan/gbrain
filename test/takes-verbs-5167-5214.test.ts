/**
 * #5167: `gbrain takes rebuild <slug>` rebuilds one page's takes index from its
 * canonical fence; `gbrain takes remove <slug> --row N` removes one row from the
 * fence and the index together (other row numbers unchanged) and refuses when
 * they disagree. #5214: an accepted proposal records `take_proposals#<id>` as
 * its source, and an edited accept records the overrides with
 * `take_proposals#<id> (edited)` while the queue keeps the original text.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall as dispatch } from '../src/mcp/dispatch.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { extractTakes } from '../src/core/cycle/extract-takes.ts';
import { acceptProposal } from '../src/core/take-proposals.ts';
import { operations } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let repo: string;
let cli: LocalRegistration;
const config = { engine: 'pglite' as const, embedding_disabled: true };

async function call(operation: string, params: Record<string, unknown>) {
  const result = await withVerifiedLocalRegistration(engine, cli,
    () => dispatch(engine, operation, { request_id: randomUUID(), ...params }, { config, remote: false, sourceId: 'default' }));
  return { error: result.isError ?? false, body: JSON.parse(result.content[0].text) };
}
/** The trusted local path `gbrain takes remove` takes (takes_remove is local-only, never an MCP tool). */
async function local(operation: string, params: Record<string, unknown>) {
  const op = operations.find(candidate => candidate.name === operation)!;
  try {
    const body = await withVerifiedLocalRegistration(engine, cli, () => op.handler({ engine, config, remote: false, sourceId: 'default', dryRun: false,
      logger: { info() {}, warn() {}, error() {} } }, { request_id: randomUUID(), ...params }));
    return { error: false, body: body as Record<string, unknown> };
  } catch (error) {
    return { error: true, body: { code: (error as { code?: string }).code, message: (error as Error).message, suggestion: (error as { suggestion?: string }).suggestion } };
  }
}
async function seed(slug: string) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `about ${slug}` }, { sourceId: 'default' });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const path = join(repo, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags), 'utf8');
}
const fence = (slug: string) => parseTakesFence(readFileSync(join(repo, `${slug}.md`), 'utf8')).takes;
async function rows(slug: string) {
  return engine.executeRaw<{ row_num: number; claim: string; source: string | null }>(
    "SELECT t.row_num, t.claim, t.source FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 ORDER BY t.row_num", [slug]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  cli = await registerLocalWriter(engine, 'cli');
  repo = mkdtempSync(join(tmpdir(), 'gbrain-takes-verbs-'));
  await engine.setConfig('sync.repo_path', repo);
  for (const slug of ['notes/rebuild', 'notes/remove', 'notes/accept']) await seed(slug);
});
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

describe('takes rebuild (#5167)', () => {
  test('restores the page index from its fence and keeps rows whose claim is unchanged', async () => {
    for (const claim of ['First claim', 'Second claim']) {
      expect((await call('takes_add', { slug: 'notes/rebuild', claim, kind: 'take', holder: 'world' })).error).toBe(false);
    }
    await engine.executeRaw("UPDATE takes SET claim='Drifted claim', resolved_quality=NULL WHERE row_num=2 AND page_id=(SELECT id FROM pages WHERE slug='notes/rebuild')");
    await engine.executeRaw("UPDATE takes SET embedded_text_hash='kept' WHERE row_num=1 AND page_id=(SELECT id FROM pages WHERE slug='notes/rebuild')");
    const result = await extractTakes(engine, { source: 'db', slugs: ['notes/rebuild'], sourceId: 'default', rebuild: true });
    expect(result.warnings).toEqual([]);
    expect((await rows('notes/rebuild')).map(row => [row.row_num, row.claim])).toEqual([[1, 'First claim'], [2, 'Second claim']]);
    const [kept] = await engine.executeRaw<{ embedded_text_hash: string | null }>(
      "SELECT embedded_text_hash FROM takes WHERE row_num=1 AND page_id=(SELECT id FROM pages WHERE slug='notes/rebuild')");
    expect(kept.embedded_text_hash).toBe('kept');
  });
});

describe('takes remove (#5167)', () => {
  test('removes one row from the fence and the index; other row numbers stay', async () => {
    for (const claim of ['Keep one', 'Drop me', 'Keep three']) {
      expect((await call('takes_add', { slug: 'notes/remove', claim, kind: 'take', holder: 'world' })).error).toBe(false);
    }
    const removed = await local('takes_remove', { slug: 'notes/remove', row_num: 2 });
    expect(removed.error).toBe(false);
    expect(removed.body).toMatchObject({ row_num: 2, removed: true });
    expect(fence('notes/remove').map(t => [t.rowNum, t.claim])).toEqual([[1, 'Keep one'], [3, 'Keep three']]);
    expect((await rows('notes/remove')).map(row => [row.row_num, row.claim])).toEqual([[1, 'Keep one'], [3, 'Keep three']]);
  });

  test('refuses when the index disagrees with the fence and names takes rebuild', async () => {
    await engine.executeRaw("UPDATE takes SET claim='Not what the fence says' WHERE row_num=3 AND page_id=(SELECT id FROM pages WHERE slug='notes/remove')");
    const refused = await local('takes_remove', { slug: 'notes/remove', row_num: 3 });
    expect(refused.error).toBe(true);
    expect(JSON.stringify(refused.body)).toContain('gbrain takes rebuild notes/remove');
    expect(fence('notes/remove').map(t => t.rowNum)).toEqual([1, 3]);
  });

  test('refuses a row another row cites as its replacement', async () => {
    expect((await call('takes_supersede', { slug: 'notes/remove', row_num: 1, claim: 'Keep one, revised' })).error).toBe(false);
    const replacement = fence('notes/remove').find(t => t.claim === 'Keep one, revised')!;
    const refused = await local('takes_remove', { slug: 'notes/remove', row_num: replacement.rowNum });
    expect(refused.error).toBe(true);
    expect(refused.body.message).toContain(`replaces row #1`);
    expect(fence('notes/remove').some(t => t.rowNum === replacement.rowNum)).toBe(true);
  });

  test('is local-only: no MCP caller can remove takes', async () => {
    expect(operations.find(candidate => candidate.name === 'takes_remove')?.localOnly).toBe(true);
    const result = await withVerifiedLocalRegistration(engine, cli, () => dispatch(engine, 'takes_remove',
      { request_id: randomUUID(), slug: 'notes/remove', row_num: 1 }, { config, remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'] }));
    expect(result.isError).toBe(true);
  });
});

describe('takes propose --accept provenance (#5214)', () => {
  async function propose(claim: string): Promise<number> {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO take_proposals
      (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, domain, model_id, status)
      VALUES ('default', 'notes/accept', md5($1), 'test-v1', 'run-test', $1, 'bet', 'world', 0.7, NULL, 'test-model', 'pending') RETURNING id`, [claim]);
    return row.id;
  }
  const target = () => ({ engine, brainDir: repo, sourceId: 'default', actedBy: 'people/tester', config });

  test('a plain accept records take_proposals#<id> as the take source', async () => {
    const id = await propose('Plain proposal claim');
    const { rowNum } = await acceptProposal(target(), id);
    expect(fence('notes/accept').find(t => t.rowNum === rowNum)?.source).toBe(`take_proposals#${id}`);
    expect((await rows('notes/accept')).find(row => row.row_num === rowNum)?.source).toBe(`take_proposals#${id}`);
  });

  test('an edited accept applies the overrides, marks the source edited, and keeps the original proposal text', async () => {
    const id = await propose('Original proposal claim');
    const { rowNum } = await acceptProposal(target(), id, { claim: 'Edited claim text', weight: 0.4, kind: 'take', holder: 'world' });
    const take = fence('notes/accept').find(t => t.rowNum === rowNum)!;
    expect([take.claim, take.weight, take.kind, take.source]).toEqual(['Edited claim text', 0.4, 'take', `take_proposals#${id} (edited)`]);
    const [queued] = await engine.executeRaw<{ claim_text: string; status: string }>('SELECT claim_text, status FROM take_proposals WHERE id=$1', [id]);
    expect(queued).toEqual({ claim_text: 'Original proposal claim', status: 'accepted' });
  });
});

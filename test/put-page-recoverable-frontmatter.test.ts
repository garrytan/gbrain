/**
 * #5988 Lane A: put_page accepts frontmatter foresights can read exactly by
 * quoting it and writes the quoted canonical form, so anything written
 * through foresights is clean on disk; frontmatter it would have to guess at is
 * refused with a typed code, the key and line, and no raw value.
 *
 * Regression it catches: put_page refusing the issue's files (the R2
 * validator bug), writing the unparseable original bytes to the canonical
 * file, or refusing without the key/line an agent needs to fix it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { parseDataFrontmatter } from '../src/core/data-frontmatter.ts';

let engine: PGLiteEngine;
let root: string;
let fixtureDir: string;
let registration: LocalRegistration;
const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  resetGateway();
  _resetWriteThroughCacheForTest();
  fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-put-recoverable-'));
  root = join(fixtureDir, 'brain'); mkdirSync(root);
  await engine.setConfig('sync.repo_path', root);
});

afterEach(async () => {
  await disposePersistenceConsumer(engine);
  resetGateway();
  _resetWriteThroughCacheForTest();
  rmSync(fixtureDir, { recursive: true, force: true });
});

function test(name: string, run: () => Promise<void>, timeout = 20_000) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
    registration = await registerLocalWriter(engine, 'stdio', {
      sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'],
    });
    try { await run(); } finally { await disposePersistenceConsumer(engine); }
  }), timeout);
}
async function put(slug: string, content: string) {
  const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'put_page', { slug, content, request_id: randomUUID() }, {
    remote: true, config: { engine: 'pglite' }, sourceId: 'default', auth,
    logger: { info() {}, warn() {}, error() {} },
  }));
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text) };
}

describe('put_page with recoverable frontmatter', () => {
  test('a quote-recoverable block commits and the canonical file is written in quoted, strictly parseable form', async () => {
    const slug = 'notes/payments-roundup';
    const author = 'PYMNTS (citing Reuters / Bloomberg) (original: https://x.com/a/status/1)';
    const result = await put(slug, `---\ntitle: Re: payments roundup\ntype: note\nauthor: ${author}\nsource: "Quoted" trailing\n---\n\nBody text.\n`);
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.state).toBe('committed');
    const page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
    expect(page.title).toBe('Re: payments roundup');
    expect(page.frontmatter).toMatchObject({ author, source: '"Quoted" trailing' });
    const disk = readFileSync(join(root, `${slug}.md`), 'utf8');
    const strict = parseDataFrontmatter(disk);
    expect(strict.data).toMatchObject({ title: 'Re: payments roundup', author, source: '"Quoted" trailing' });
  });

  test('frontmatter that needs guessing is refused remotely with a typed code and its line, never a key name or raw value', async () => {
    const result = await put('notes/guess', '---\ntitle: alice-example first line\nalice-example second line\ntype: note\n---\n\nBody.\n');
    expect(result.response.isError).toBe(true);
    const text = JSON.stringify(result.payload);
    expect(text).not.toContain('alice-example');
    expect(result.payload).toMatchObject({ error: 'invalid_params', code: 'invalid_frontmatter', reason: 'needs_interpretation', detail: 'line 2' });
    expect(result.payload.suggestion).toContain('frontmatter line 2:');
    expect(result.payload.message).not.toContain('"title"');
    expect(await engine.readPageSnapshot('notes/guess', { sourceId: 'default' })).toBeNull();
  });

  test('a protected key that would be read as a broader value is refused', async () => {
    const result = await put('notes/private', '---\ntitle: "Hello\nvisibility: private\nsummary: x"\n---\n\nBody.\n');
    expect(result.response.isError).toBe(true);
    expect(result.payload).toMatchObject({ code: 'invalid_frontmatter', reason: 'ambiguous_protected_key', detail: 'line 3' });
    expect(await engine.readPageSnapshot('notes/private', { sourceId: 'default' })).toBeNull();
  });
});

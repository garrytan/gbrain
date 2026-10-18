/**
 * D8 adoption funnel through the real operations (PGLite, MCP dispatch) and
 * `runImport`: each committed event is recorded once recording is on, nothing
 * is written while it is off, and no content reaches the record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runImport } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';
import { __setFunnelPathForTests, enableFunnel } from '../src/core/funnel.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-funnel-ops-'));
let engine: PGLiteEngine;
let path: string;
let n = 0;

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
const events = () => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(l => (JSON.parse(l) as { event: string }).event) : [];

async function journey() {
  expect((await call('put_page', { slug: 'people/alice-example', content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nAlice Example works on the zephyrine project.\n' })).isError).toBe(false);
  const first = await call('remember', { fact: 'Alice Example works at acme-example.', provenance: 'test', entity: 'people/alice-example' });
  expect(first.body.status).toBe('inserted');
  const replaced = await call('remember', { fact: 'Alice Example left acme-example in 2026.', provenance: 'test', entity: 'people/alice-example', replaces: first.body.id });
  expect(replaced.body.status).toBe('superseded');
  const searched = await call('search', { query: 'zephyrine' });
  expect(searched.isError).toBe(false);
  expect((searched.body as unknown as unknown[]).length).toBeGreaterThan(0);
  const other = await call('remember', { fact: 'Alice Example prefers async standups.', provenance: 'test', entity: 'people/alice-example' });
  expect((await call('forget', { id: other.body.id })).isError).toBe(false);
  expect((await call('recall', { entity: 'people/alice-example' })).isError).toBe(false);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  __setFunnelPathForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const dir = join(root, `case-${n++}`);
  path = join(dir, 'funnel.jsonl');
  __setFunnelPathForTests(path);
});

describe('funnel through operations', () => {
  test('off by default: a full save, correct, search, forget, recall journey writes nothing', async () => {
    await journey();
    expect(existsSync(path)).toBe(false);
  });

  test('on: one save and one recall for the session, the correction and the withdrawal; no content in the record', async () => {
    enableFunnel();
    await journey();
    expect(events()).toEqual(['enabled', 'save', 'correction', 'recall', 'withdrawal']);
    expect(readFileSync(path, 'utf8')).not.toMatch(/alice|acme|zephyrine|people\//i);
  });

  test('on: takes_supersede is a correction and forget_fact a withdrawal', async () => {
    await call('put_page', { slug: 'companies/acme-example', content: '---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nA company.\n' });
    expect((await call('takes_add', { slug: 'companies/acme-example', claim: 'Acme Example will ship in Q3.', kind: 'take', holder: 'world' })).isError).toBe(false);
    const fact = await call('remember', { fact: 'Acme Example is based in Lisbon.', provenance: 'test', entity: 'companies/acme-example' });
    enableFunnel();
    const superseded = await call('takes_supersede', { slug: 'companies/acme-example', row_num: 1, claim: 'Acme Example will ship in Q4.' });
    expect(superseded.isError).toBe(false);
    expect((await call('forget_fact', { id: Number(fact.body.id) })).isError).toBe(false);
    expect(events()).toEqual(['enabled', 'correction', 'withdrawal']);
  });

  test('on: an import that saved pages is recorded; an import that saved none is not', async () => {
    enableFunnel();
    const repo = join(root, `repo-${n}`);
    mkdirSync(repo);
    execSync('git init -q && git config user.email t@t.t && git config user.name T', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'note.md'), '---\ntype: note\n---\n# Note\n\nbody\n');
    execSync('git add note.md && git commit -qm seed', { cwd: repo, stdio: 'pipe' });
    await withEnv({ GBRAIN_HOME: join(root, `home-${n}`) }, async () => {
      expect((await runImport(engine, [repo, '--no-embed', '--json'])).imported).toBe(1);
      expect((await runImport(engine, [repo, '--no-embed', '--json'])).imported).toBe(0);
    });
    expect(events()).toEqual(['enabled', 'import']);
  });
});

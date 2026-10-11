/**
 * #6450 — an unresolvable malformed holder must be refused at the takes write
 * boundary before ANY page / file / facts / takes state changes, on the trusted
 * local path as well as the managed path; valid canonical and legacy bare-slug
 * holders must keep being accepted.
 *
 * Fail-first on master: `takes_add` checks only `typeof holder === 'string'`
 * plus the allow-list, and `takes_supersede` accepts an explicit `holder`
 * override the same way — `isValidHolder` (v0.32 EXP-4 grammar) is never
 * consulted on the write path, so '' / '   ' / 'Not A Slug!' are written into
 * the fence and mirrored into the takes table.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall as dispatch, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let repo: string;
let stdio: LocalRegistration;
let cli: LocalRegistration;
const extraRoots: string[] = [];

async function dispatchToolCall(db: PGLiteEngine, operation: string, params: Record<string, unknown>, opts: DispatchOpts) {
  const request = { request_id: randomUUID(), ...params };
  return withVerifiedLocalRegistration(db, opts.remote === false ? cli : stdio,
    () => dispatch(db, operation, request, { config: { engine: 'pglite', embedding_disabled: true }, ...opts }));
}
async function mirrorFixture(slug: string, path = join(repo, `${slug}.md`), sourceId = 'default') {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags), 'utf8');
}
async function seedFixture(slug: string, body = `about ${slug}`, path = join(repo, `${slug}.md`), sourceId = 'default') {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId });
  await mirrorFixture(slug, path, sourceId);
}
const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
const STDIO_WORLD = { ...STDIO, takesHoldersAllowList: ['world'] };
const LOCAL = { remote: false as const, sourceId: 'default' };

function parsed(result: { isError?: boolean; content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}
function pageMd(slug: string): string {
  return readFileSync(join(repo, `${slug}.md`), 'utf-8');
}
async function activeRowCount(slug: string): Promise<number> {
  return (await engine.listTakes({ page_slug: slug, active: true })).length;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  stdio = await registerLocalWriter(engine, 'stdio');
  cli = await registerLocalWriter(engine, 'cli');
  repo = mkdtempSync(join(tmpdir(), 'gbrain-takes-holder-refusal-'));
  execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo });
  await engine.setConfig('sync.repo_path', repo);
  for (const slug of ['notes/holder-target', 'notes/holder-supersede', 'notes/holder-legacy']) {
    await seedFixture(slug);
  }
  execSync('git add -A && git commit -qm seed', { cwd: repo });
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  for (const root of [repo, ...extraRoots]) rmSync(root, { recursive: true, force: true });
});

describe('#6450 malformed holder refused before any state change', () => {
  const MALFORMED: Array<[string, string]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-slug text', 'Not A Slug!'],
  ];

  for (const [label, holder] of MALFORMED) {
    test(`local takes_add refuses a ${label} holder and leaves page, file and takes untouched`, async () => {
      const beforePage = pageMd('notes/holder-target');
      const beforeRows = await activeRowCount('notes/holder-target');
      const res = await dispatchToolCall(engine, 'takes_add',
        { slug: 'notes/holder-target', claim: `claim for ${label}`, kind: 'fact', holder }, { ...LOCAL });
      expect(res.isError ?? false).toBe(true);
      expect(parsed(res).error).toBe('invalid_params');
      expect(pageMd('notes/holder-target')).toBe(beforePage);
      expect(await activeRowCount('notes/holder-target')).toBe(beforeRows);
    });
  }

  test('managed (stdio) takes_add refuses a malformed holder before any state change', async () => {
    const beforePage = pageMd('notes/holder-target');
    const beforeRows = await activeRowCount('notes/holder-target');
    const res = await dispatchToolCall(engine, 'takes_add',
      { slug: 'notes/holder-target', claim: 'managed malformed holder', kind: 'fact', holder: '   ' }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(true);
    // Syntax is judged before authority, so a malformed holder is invalid_params
    // rather than a permission denial that would mask the real defect.
    expect(parsed(res).error).toBe('invalid_params');
    expect(pageMd('notes/holder-target')).toBe(beforePage);
    expect(await activeRowCount('notes/holder-target')).toBe(beforeRows);
  });

  test('takes_supersede refuses an explicitly malformed holder override before any state change', async () => {
    const seeded = parsed(await dispatchToolCall(engine, 'takes_add',
      { slug: 'notes/holder-supersede', claim: 'original claim', kind: 'take', holder: 'world' }, { ...STDIO_WORLD }));
    const rowNum = seeded.row_num as number;
    const beforePage = pageMd('notes/holder-supersede');
    const res = await dispatchToolCall(engine, 'takes_supersede',
      { slug: 'notes/holder-supersede', row_num: rowNum, claim: 'replacement claim', holder: '' }, { ...LOCAL });
    expect(res.isError ?? false).toBe(true);
    expect(parsed(res).error).toBe('invalid_params');
    expect(pageMd('notes/holder-supersede')).toBe(beforePage);
    const rows = await engine.listTakes({ page_slug: 'notes/holder-supersede', active: true });
    expect(rows.length).toBe(1);
    expect(rows[0].claim).toBe('original claim');
  });

  test('legacy bare-slug holder is still accepted (regression guard)', async () => {
    const res = await dispatchToolCall(engine, 'takes_add',
      { slug: 'notes/holder-legacy', claim: 'legacy holder stays valid', kind: 'fact', holder: 'alice-example' }, { ...LOCAL });
    expect(res.isError ?? false).toBe(false);
    expect(parsed(res).row_num).toBe(1);
    expect(parseTakesFence(pageMd('notes/holder-legacy')).takes[0].holder).toBe('alice-example');
  });

  test('canonical people/<slug> holder is still accepted (regression guard)', async () => {
    const res = await dispatchToolCall(engine, 'takes_add',
      { slug: 'notes/holder-legacy', claim: 'canonical holder stays valid', kind: 'fact', holder: 'people/dana-example' }, { ...LOCAL });
    expect(res.isError ?? false).toBe(false);
    expect(parsed(res).row_num).toBe(2);
  });
});

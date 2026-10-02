/**
 * #5622 / #5603: `capture --file` stored `file://<path as typed>`. A relative
 * path produced a host-bearing URI that resolves differently per process and,
 * once a shared skillpack exists, refused every write to the page. Capture now
 * records a source-relative source_path for a file inside the source (never a
 * file URI or a home path), `cli-file` for anything else, and legacy relative
 * URIs are read as absent.
 * The relative-path and special-character filename cases are adapted from
 * community PR #5670.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runCapture } from '../src/commands/capture.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { recordedPathFromFileUri } from '../src/core/write-through.ts';
import { isRelativeFileUri, resolveSourceLocalFilePath } from '../src/core/markdown.ts';
import { execFileSync } from 'node:child_process';
import { resolveSlugForPath } from '../src/core/sync.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); resetGateway(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-capture-path-')));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(path.join(brainDir, 'notes'), { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.setConfig('schema_pack', 'gbrain-base');
});
async function capture(args: string[]) {
  const log = console.log; console.log = () => {};
  try { await runCapture(engine, [...args, '--quiet']); } finally { console.log = log; }
}
const row = async (slug: string) => (await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
  "SELECT source_path,source_uri FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];

test('relative and absolute captures of an in-source file record its source-relative path and no file URI', async () => {
  const relativeFile = path.join(brainDir, 'notes', 'in-source.md');
  fs.writeFileSync(relativeFile, '# In source\n\nA captured observation inside the source.\n');
  await capture(['--file', path.relative(process.cwd(), relativeFile), '--slug', 'notes/in-source']);
  expect(await row('notes/in-source')).toEqual({ source_path: 'notes/in-source.md', source_uri: null });
  expect(fs.readFileSync(relativeFile, 'utf8')).toContain('A captured observation inside the source.');
  expect(fs.readdirSync(path.join(brainDir, 'notes'))).toEqual(['in-source.md']);

  const special = path.join(brainDir, 'notes', 'note #1.md');
  fs.writeFileSync(special, '# Special\n\nA captured observation with a special file name.\n');
  const slug = resolveSlugForPath('notes/note #1.md');
  await capture(['--file', special, '--slug', slug]);
  expect(await row(slug)).toEqual({ source_path: 'notes/note #1.md', source_uri: null });
});

test('an external file or an in-source file captured under another slug records no path and targets the slug', async () => {
  const outside = path.join(tmpRoot, 'outside.md');
  fs.writeFileSync(outside, '# Outside\n\nA captured observation outside the source.\n');
  await capture(['--file', path.relative(process.cwd(), outside), '--slug', 'inbox/external']);
  expect(await row('inbox/external')).toEqual({ source_path: 'inbox/external.md', source_uri: 'cli-file' });
  expect(fs.readFileSync(outside, 'utf8')).toBe('# Outside\n\nA captured observation outside the source.\n');

  const inside = path.join(brainDir, 'notes', 'other-name.md');
  fs.writeFileSync(inside, '# Inside\n\nAn in-source observation captured under an inbox slug.\n');
  await capture(['--file', inside, '--slug', 'inbox/renamed']);
  expect(await row('inbox/renamed')).toEqual({ source_path: 'inbox/renamed.md', source_uri: 'cli-file' });
  expect(fs.readFileSync(inside, 'utf8')).toBe('# Inside\n\nAn in-source observation captured under an inbox slug.\n');

  const ctx = { engine, remote: true, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
    auth: { clientId: 'example-reader', scopes: ['read'], sourceId: 'default' },
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  for (const slug of ['inbox/external', 'inbox/renamed']) {
    const page = await operationsByName.get_page!.handler(ctx, { slug });
    expect(JSON.stringify(page)).not.toContain(tmpRoot);
  }
});

test('a legacy relative file URI never resolves against the process directory', () => {
  const previous = process.cwd();
  process.chdir(tmpRoot);
  try {
    fs.writeFileSync(path.join(brainDir, 'notes', 'legacy.md'), 'Legacy captured file.\n');
    expect(recordedPathFromFileUri('file://brain/notes/legacy.md', brainDir)).toBeNull();
    expect(recordedPathFromFileUri('file://notes/legacy.md', brainDir)).toBeNull();
    expect(recordedPathFromFileUri(`file://${path.join(brainDir, 'notes', 'legacy.md')}`, brainDir)).toBe(path.join('notes', 'legacy.md'));
    expect(recordedPathFromFileUri(`file://localhost${path.join(brainDir, 'notes', 'legacy.md')}`, brainDir)).toBe(path.join('notes', 'legacy.md'));
  } finally { process.chdir(previous); }
});

test('remote callers cannot name a local capture file or a capture path', async () => {
  const ctx = { engine, remote: true, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
    auth: { clientId: 'example-writer', scopes: ['write'], sourceId: 'default' },
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  for (const extra of [{ local_file: path.join(brainDir, 'notes', 'x.md') }, { capture_path: 'notes/x.md' }]) {
    await expect(operationsByName.capture!.handler(ctx, { content: 'Remote capture body.', slug: 'notes/x', ...extra }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  }
});

test('historical absolute Windows drive URIs stay absolute while relative and host-only URIs are absent', () => {
  for (const uri of ['file:///home/example/notes/a.md', 'file://localhost/home/example/a.md', 'file://C:/vault/notes/a.md', 'file://C:\\vault\\notes\\a.md']) {
    expect(isRelativeFileUri(uri)).toBe(false);
  }
  for (const uri of ['file://notes/a.md', 'file://example-note.md', 'file://server/share/a.md', 'file://../../tmp/a.md']) {
    expect(isRelativeFileUri(uri)).toBe(true);
  }
});

test('a git-root subdirectory source binds an in-source capture under its Git-prefixed slug without a twin', async () => {
  const repo = path.join(tmpRoot, 'repo');
  const scoped = path.join(repo, 'docs');
  fs.mkdirSync(scoped, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  await engine.setConfig('sync.repo_path', scoped);
  await engine.setConfig('sync.slug_root_mode', 'git-root');
  const file = path.join(scoped, 'a.md');
  fs.writeFileSync(file, '# A\n\nA git-root scoped capture.\n');
  await capture(['--file', file, '--slug', 'docs/a']);
  expect(await row('docs/a')).toEqual({ source_path: 'docs/a.md', source_uri: null });
  expect(fs.readFileSync(file, 'utf8')).toContain('A git-root scoped capture.');
  expect(fs.existsSync(path.join(scoped, 'docs'))).toBe(false);
});

test('source-path decoding follows the slug-root mode, including the legacy Git-root form and basename rows', () => {
  const repo = path.join(tmpRoot, 'decode');
  const scoped = path.join(repo, 'docs');
  fs.mkdirSync(path.join(scoped, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(scoped, 'docs', 'a.md'), 'nested');
  fs.writeFileSync(path.join(scoped, 'a.md'), 'sibling');
  expect(resolveSourceLocalFilePath(scoped, 'docs/a.md', 'docs/a', 'source-root')).toBe(path.join(scoped, 'docs', 'a.md'));
  expect(resolveSourceLocalFilePath(scoped, 'docs/a.md', 'a', 'source-root')).toBe(path.join(scoped, 'a.md'));
  expect(resolveSourceLocalFilePath(scoped, 'docs/a.md', 'docs/a', 'git-root')).toBe(path.join(scoped, 'a.md'));
  fs.rmSync(path.join(scoped, 'a.md'));
  expect(resolveSourceLocalFilePath(scoped, 'a.md', 'docs/a', 'source-root')).toBe(path.join(scoped, 'docs', 'a.md'));
});

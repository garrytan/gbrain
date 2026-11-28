/**
 * GST-3743: gbrain's own derived writes stay out of a checkout nothing on this host commits. A source other than
 * `default` whose root is a Git checkout that is neither git-canonical nor durable on this host is fed from another
 * writer's remote: a managed atom run and a sync import's fence normalization keep their result in the database, write
 * no file, leave `git status` clean, and every import of one sync pass reports the same database-only reason. A durable
 * checkout of the same shape still gets its normalized file (control). Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { foreignCheckout } from '../src/core/persistence/git-durability-policy.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-foreign-checkout-'));
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const fixable = (title: string) => `---\ntitle: ${title}\n---\nA synthetic page.\n\n${FB}\n${FH}\n| 1 | Example claim about acme-example | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n${FBE}\n`;
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation.\n`;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

/** A non-default source in a Git checkout claimed on this host; `durable` installs the managed post-commit hook. */
async function source(files: Record<string, string>, opts: { durable?: boolean; git?: boolean } = {}) {
  const id = `source-a-${randomUUID().slice(0, 8)}`, root = join(home, id);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  if (opts.git !== false) {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
    if (opts.durable) { writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n'); chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755); }
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture', '--allow-empty');
  }
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

test('a sync pass over a foreign checkout normalizes in the database only, writes no file and reports one mode for every import', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const s = await source({ 'notes/a.md': note('A'), 'notes/b.md': note('B'), 'people/fixable.md': fixable('Fixable') });
  expect(await foreignCheckout(engine, s.id, await getWorktreeBinding(engine, s.id))).toBe(true);
  const before = readFileSync(join(s.root, 'people/fixable.md'), 'utf8');
  const result = await performManagedSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true });
  expect(result).toMatchObject({ added: 3, fences_normalized: { count: 1, database_only: 1 } });
  // GST-4061: the summary never calls a rewrite that stayed in the database committed.
  expect(result.fences_normalized!.fix.why).not.toContain('committed');
  expect(result.fences_normalized!.fix.why).toContain('in the brain only');
  expect(readFileSync(join(s.root, 'people/fixable.md'), 'utf8')).toBe(before);
  expect(git(s.root, 'status', '--porcelain')).toBe('');
  const receipts = await engine.executeRaw<{ mode: string; skipped: string | null }>(
    `SELECT outcome->'persistence'->>'mode' AS mode, outcome->'write_through'->>'skipped' AS skipped FROM persistence_requests
      WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' AND state='committed'`, [s.id]);
  expect(receipts).toHaveLength(3);
  for (const receipt of receipts) expect(receipt).toEqual({ mode: 'database', skipped: 'foreign_checkout' });
  expect(await engine.executeRaw(`SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git'`, [s.id])).toHaveLength(0);
  await disposePersistenceConsumer(engine);
}), 180_000);

test('control: a durable checkout of the same shape still gets its normalized file', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const s = await source({ 'people/fixable.md': fixable('Fixable') }, { durable: true });
  expect(await foreignCheckout(engine, s.id, await getWorktreeBinding(engine, s.id))).toBe(false);
  const before = readFileSync(join(s.root, 'people/fixable.md'), 'utf8');
  const result = await performManagedSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true });
  expect(readFileSync(join(s.root, 'people/fixable.md'), 'utf8')).not.toBe(before);
  expect(result.fences_normalized).not.toHaveProperty('database_only');
  expect(result.fences_normalized!.fix.why).toContain('rewrote losslessly and committed');
  await disposePersistenceConsumer(engine);
}), 180_000);

const chat = async (): Promise<ChatResult> => ({ text: JSON.stringify([{ title: 'Patience compounds', atom_type: 'insight', body: 'Patience compounds over years.' }]),
  blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });

async function extractInto(s: { id: string; root: string }) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const page = await engine.putPage('notes/example', { type: 'source', title: 'Example', compiled_truth: 'A careful project record. '.repeat(40) }, { sourceId: s.id });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const result = await runPhaseExtractAtoms(engine, { sourceId: s.id, _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chat });
  await disposePersistenceConsumer(engine);
  const atoms = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL`, [s.id]);
  return { result, atoms };
}

test('a managed atom run over a foreign checkout publishes its atoms database-only and leaves the checkout clean', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const s = await source({ 'README.md': 'Fed from another writer.\n' });
  const { result, atoms } = await extractInto(s);
  expect(result.status).toBe('ok');
  expect(atoms).toHaveLength(1);
  expect(existsSync(join(s.root, `${atoms[0]!.slug}.md`))).toBe(false);
  expect(existsSync(join(s.root, 'atoms'))).toBe(false);
  expect(git(s.root, 'status', '--porcelain')).toBe('');
  const receipts = await engine.executeRaw<{ mode: string; skipped: string | null }>(
    `SELECT outcome->'persistence'->>'mode' AS mode, outcome->'write_through'->>'skipped' AS skipped FROM persistence_requests
      WHERE source_id=$1 AND intent->>'kind'='managed_atom_page' AND state='committed'`, [s.id]);
  expect(receipts.length).toBeGreaterThan(0);
  for (const receipt of receipts) expect(receipt).toEqual({ mode: 'database', skipped: 'foreign_checkout' });
}), 180_000);

test('control: a plain folder the host claimed still gets its atom files', () => withEnv({ GBRAIN_HOME: home }, async () => {
  const s = await source({ 'README.md': 'A plain folder.\n' }, { git: false });
  const { atoms } = await extractInto(s);
  expect(atoms).toHaveLength(1);
  expect(existsSync(join(s.root, `${atoms[0]!.slug}.md`))).toBe(true);
}), 180_000);

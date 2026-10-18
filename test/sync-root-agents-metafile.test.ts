/**
 * #5186 (W14 P1.5b): `gbrain harden` scaffolds `AGENTS.md` / `CLAUDE.md` at the
 * source root as agent instructions, not brain content. Sync classifies the
 * root-level pair as `metafile` (depth 0 only; `docs/AGENTS.md` is still a
 * page), full import skips them the same way, and a root `agents` page an
 * earlier gbrain indexed survives re-sync under the #1433 metafile guard.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isSyncable, unsyncableReason } from '../src/core/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('root AGENTS.md / CLAUDE.md classify as metafile', () => {
  test('depth 0 only', () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      expect(isSyncable(path)).toBe(false);
      expect(unsyncableReason(path)).toBe('metafile');
    }
    for (const path of ['docs/AGENTS.md', 'skills/CLAUDE.md', 'agents.md', 'AGENTS-notes.md']) {
      expect(isSyncable(path)).toBe(true);
    }
  });
});

describe('#5186 — a hardened root AGENTS.md is not imported, and an existing root page survives', () => {
  let engine: PGLiteEngine;
  let repoPath: string;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);
  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-root-agents-'));
    execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    mkdirSync(join(repoPath, 'docs'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/foo.md'), '---\ntype: concept\ntitle: Foo\n---\n\nBaseline content.\n');
    writeFileSync(join(repoPath, 'AGENTS.md'), '# Agents working on this brain\n\nRecall before answering.\n');
    writeFileSync(join(repoPath, 'CLAUDE.md'), '# Claude\n\nRead AGENTS.md.\n');
    writeFileSync(join(repoPath, 'docs/AGENTS.md'), '---\ntype: concept\ntitle: Agents guide\n---\n\nA page about agents.\n');
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });
  afterEach(() => { if (repoPath) rmSync(repoPath, { recursive: true, force: true }); });

  test('full and incremental sync skip the root pair and keep the nested page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(first.status);
    expect(await engine.getPage('agents')).toBeNull();
    expect(await engine.getPage('claude')).toBeNull();
    expect(await engine.getPage('docs/agents')).not.toBeNull();
    expect(await engine.getPage('topics/foo')).not.toBeNull();

    writeFileSync(join(repoPath, 'AGENTS.md'), '# Agents working on this brain\n\nRecall before answering. Save with provenance.\n');
    execSync('git add -A && git commit -m "edit agents"', { cwd: repoPath, stdio: 'pipe' });
    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'first_sync', 'up_to_date']).toContain(second.status);
    expect(await engine.getPage('agents')).toBeNull();
  }, 60_000);

  test('a root agents page indexed by an earlier gbrain survives re-sync (#1433 guard)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    await engine.putPage('agents', { type: 'concept', title: 'Agents', compiled_truth: 'Pre-existing page that should survive re-sync.', timeline: '', frontmatter: { type: 'concept' } });
    expect(await engine.getPage('agents')).not.toBeNull();

    writeFileSync(join(repoPath, 'AGENTS.md'), '# Agents working on this brain\n\nEdited after indexing.\n');
    execSync('git add -A && git commit -m "edit agents"', { cwd: repoPath, stdio: 'pipe' });
    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'first_sync', 'blocked_by_failures', 'up_to_date']).toContain(second.status);
    const survivor = await engine.getPage('agents');
    expect(survivor).not.toBeNull();
    expect(survivor?.compiled_truth).toContain('Pre-existing page');
  }, 60_000);
});

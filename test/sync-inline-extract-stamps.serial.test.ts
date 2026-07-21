/**
 * CRITICAL regression (v0.42.7, #1696, CDX-6) — inline sync extract stamps the
 * link-extraction watermark.
 *
 * `performSync`'s INCREMENTAL path runs link/timeline extraction inline for the
 * changed pages (the `gbrain sync` default — see performSyncInner's auto-extract
 * block). v0.42.7 adds a `stampExtracted` call at that call site (after
 * extractLinksForSlugs/extractTimelineForSlugs) so a normal incremental sync
 * marks the pages it just extracted as fresh — otherwise every synced page
 * would show as stale forever in the links_extraction_lag doctor check.
 *
 * NOTE: a FULL / first sync routes to performFullSync which does NOT extract
 * inline (pre-existing behavior — exactly the "imported ≠ curated" gap that
 * `extract --stale` closes). So this regression test drives the INCREMENTAL
 * path: full sync to seed, then edit + incremental sync.
 *
 * IRON RULE: pins (a) an incremental sync NOW stamps links_extracted_at for the
 * pages it processed, and (b) the existing link extraction is unchanged. Plus
 * --no-extract: the changed page stays unstamped AND no links are created.
 *
 * Marked .serial.test.ts — spawns git subprocesses + shares one PGLite engine.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

function git(cmd: string): void { execSync(cmd, { cwd: repoPath, stdio: 'pipe' }); }

function writeAcme(body: string): void {
  writeFileSync(join(repoPath, 'companies/acme.md'), [
    '---', 'type: company', 'title: Acme', '---', '', body,
  ].join('\n'));
}

async function stampOf(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
    `SELECT links_extracted_at FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug],
  );
  return rows[0]?.links_extracted_at ?? null;
}

describe('#1696 — inline sync extract stamps links_extracted_at', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-stamp-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    mkdirSync(join(repoPath, 'companies'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---', 'type: person', 'title: Alice', '---', '', 'Alice is a founder.',
    ].join('\n'));
    writeAcme('Acme is a company.');
    git('git add -A && git commit -m "initial"');

    // Seed: full first sync imports both pages (no inline extract on this path).
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('(a) incremental sync stamps the watermark AND (b) still extracts the link', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Edit acme to add the link, commit → incremental sync processes it.
    // Disk-relative link form (how real brain files reference each other on
    // disk; the FS extractor resolves relative to the file's directory).
    writeAcme('[Alice](../people/alice.md) is the CEO of Acme.');
    git('git add -A && git commit -m "add link"');
    const result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'first_sync']).toContain(result.status);

    // (b) extraction unchanged — the CEO-of link is created.
    const links = await engine.getLinks('companies/acme');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);

    // (a) the changed page sync extracted is now stamped (not stale).
    expect(await stampOf('companies/acme')).not.toBeNull();
  }, 60_000);

  test('--no-extract: changed page is NOT stamped and no links are created', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Disk-relative link form (how real brain files reference each other on
    // disk; the FS extractor resolves relative to the file's directory).
    writeAcme('[Alice](../people/alice.md) is the CEO of Acme.');
    git('git add -A && git commit -m "add link"');
    const result = await performSync(engine, { repoPath, noPull: true, noEmbed: true, noExtract: true });
    expect(['synced', 'first_sync']).toContain(result.status);

    expect(await engine.getLinks('companies/acme')).toHaveLength(0);
    expect(await stampOf('companies/acme')).toBeNull();
  }, 60_000);
});

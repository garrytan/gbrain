/**
 * brainstorm/lsd --save persistence tests.
 *
 * Covers persistSavedIdea (canonical importFromContent + shared write-through),
 * formatSaveOutcome (honest message + exit code), and buildIdeaSlug
 * (collision-resistant nonce). Includes the two regression cases for the
 * silent-false-success bug class: DB import throws → exit 1 "NOT persisted";
 * file write fails but DB row landed → exit 0 (durable, sync reconciles).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  persistSavedIdea,
  formatSaveOutcome,
  buildIdeaSlug,
  type SaveOutcome,
} from '../../src/commands/brainstorm.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-bs-save-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const sampleContent = () =>
  serializeMarkdown({ mode: 'lsd', question: 'why X' }, '# LSD: why X\n\nbody', '', {
    type: 'note',
    title: 'LSD: why X',
    tags: [],
  });

describe('persistSavedIdea', () => {
  test('both sinks: canonical DB import (chunks written) + file rendered from row', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const slug = buildIdeaSlug('why X', 'lsd', 'nonce01');
    const o = await persistSavedIdea(engine, { slug, content: sampleContent(), provenanceVia: 'lsd' });

    expect(o.dbSaved).toBe(true);
    expect(o.writeThrough.written).toBe(true);
    expect(fs.existsSync(o.writeThrough.path!)).toBe(true);

    // Canonical proof: importFromContent wrote chunks. Raw engine.putPage (the
    // pre-fix path) would write ZERO chunks, so the page would be unsearchable
    // and the next sync would churn the row.
    const rows = await engine.executeRaw<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM content_chunks ch JOIN pages p ON p.id = ch.page_id WHERE p.slug = $1',
      [slug],
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });

  test('no repo configured → DB canonical, writeThrough skipped, exit 0', async () => {
    await engine.setConfig('sync.repo_path', '');
    const slug = buildIdeaSlug('why Y', 'lsd', 'nonce02');
    const o = await persistSavedIdea(engine, { slug, content: sampleContent(), provenanceVia: 'lsd' });

    expect(o.dbSaved).toBe(true);
    expect(o.writeThrough.skipped).toBe('no_repo_configured');
    const m = formatSaveOutcome(o, { profileLabel: 'lsd', slug });
    expect(m.exitCode).toBe(0);
    expect(m.stdout).toContain('no `sync.repo_path`');
  });

  test('[REGRESSION] DB import throws → nothing persisted → exit 1 NOT persisted', async () => {
    // A dead/garbage engine makes importFromContent throw immediately — the
    // shape of the original PgBouncer "DB write failed but said saved" bug.
    const deadEngine = {} as unknown as BrainEngine;
    const slug = buildIdeaSlug('why Z', 'lsd', 'nonce03');
    const o = await persistSavedIdea(deadEngine, { slug, content: sampleContent(), provenanceVia: 'lsd' });

    expect(o.dbSaved).toBe(false);
    expect(typeof o.dbError).toBe('string');
    expect(o.writeThrough.written).toBe(false);

    const m = formatSaveOutcome(o, { profileLabel: 'lsd', slug });
    expect(m.exitCode).toBe(1);
    expect(m.stdout).toBeUndefined();
    expect(m.stderr.some((l) => l.includes('NOT persisted'))).toBe(true);
  });

  test('[REGRESSION] repo set but file write fails (ENOTDIR) → DB saved, exit 0, warns', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    fs.writeFileSync(path.join(brainDir, 'wiki'), 'blocker'); // blocks wiki/ideas/
    const slug = buildIdeaSlug('why W', 'lsd', 'nonce04'); // wiki/ideas/...-nonce04
    const o = await persistSavedIdea(engine, { slug, content: sampleContent(), provenanceVia: 'lsd' });

    expect(o.dbSaved).toBe(true);
    expect(o.writeThrough.written).toBe(false);
    expect(typeof o.writeThrough.error).toBe('string');

    const m = formatSaveOutcome(o, { profileLabel: 'lsd', slug });
    expect(m.exitCode).toBe(0); // row is durable; sync reconciles the file
    expect(m.stdout).toContain('file NOT written');
    expect(m.stderr.some((l) => l.includes('file write failed'))).toBe(true);
  });
});

describe('formatSaveOutcome (pure)', () => {
  const ctx = { profileLabel: 'lsd', slug: 'wiki/ideas/x' };

  test('both written → exit 0, names both sinks', () => {
    const o: SaveOutcome = { dbSaved: true, writeThrough: { written: true, path: '/r/x.md' } };
    const m = formatSaveOutcome(o, ctx);
    expect(m.exitCode).toBe(0);
    expect(m.stdout).toContain('and file');
    expect(m.stderr).toEqual([]);
  });

  test('db only, repo_not_found → exit 0', () => {
    const o: SaveOutcome = { dbSaved: true, writeThrough: { written: false, skipped: 'repo_not_found' } };
    const m = formatSaveOutcome(o, ctx);
    expect(m.exitCode).toBe(0);
    expect(m.stdout).toContain('not a directory');
  });

  test('db saved but file errored → exit 0, warns on stderr', () => {
    const o: SaveOutcome = { dbSaved: true, writeThrough: { written: false, error: 'EACCES' } };
    const m = formatSaveOutcome(o, ctx);
    expect(m.exitCode).toBe(0);
    expect(m.stdout).toContain('file NOT written');
    expect(m.stderr.some((l) => l.includes('EACCES'))).toBe(true);
  });

  test('nothing persisted → exit 1, both error lines on stderr', () => {
    const o: SaveOutcome = {
      dbSaved: false,
      dbError: 'boom',
      writeThrough: { written: false, skipped: 'page_not_found_after_write' },
    };
    const m = formatSaveOutcome(o, ctx);
    expect(m.exitCode).toBe(1);
    expect(m.stdout).toBeUndefined();
    expect(m.stderr.some((l) => l.includes('DB save failed: boom'))).toBe(true);
    expect(m.stderr.some((l) => l.includes('NOT persisted'))).toBe(true);
  });
});

describe('buildIdeaSlug', () => {
  test('distinct nonces → distinct slugs (no same-day clobber)', () => {
    const a = buildIdeaSlug('same question', 'lsd', 'aaa');
    const b = buildIdeaSlug('same question', 'lsd', 'bbb');
    expect(a).not.toBe(b);
    expect(a.startsWith('wiki/ideas/')).toBe(true);
  });

  test('empty question → untitled stem, still unique by nonce', () => {
    const a = buildIdeaSlug('', 'lsd', 'aaa');
    const b = buildIdeaSlug('', 'lsd', 'bbb');
    expect(a).toContain('-untitled-');
    expect(a).not.toBe(b);
  });

  test('production nonce (no arg) is random → two calls differ', () => {
    const a = buildIdeaSlug('q', 'brainstorm');
    const b = buildIdeaSlug('q', 'brainstorm');
    expect(a).not.toBe(b);
  });
});

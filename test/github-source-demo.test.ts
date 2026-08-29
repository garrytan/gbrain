import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderItemPage, renderRepoCard, itemPagePath, repoCardPath } from '../src/core/github-source.ts';
import { runSourcesDemo } from '../src/commands/sources-demo.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { DEMO_ITEMS, DEMO_REPOS } from '../src/fixtures/github-demo.ts';

function makeOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-demo-'));
  return dir;
}

describe('github-source demo fixture', () => {
  test('fixture covers both item kinds plus multiple repos', () => {
    expect(DEMO_ITEMS.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(DEMO_ITEMS.map((i) => i.kind));
    expect(kinds).toEqual(new Set(['issue', 'pr']));
    const repos = new Set(DEMO_ITEMS.map((i) => i.repo));
    expect(repos.size).toBeGreaterThan(1);
  });

  test('renderItemPage renders every fixture item offline (no network/token)', () => {
    for (const item of DEMO_ITEMS) {
      const page = renderItemPage(item);
      expect(page).toContain(`kind: ${item.kind}`);
      expect(page).toContain(`repo: "${item.repo}"`);
      expect(page).toContain(`number: ${item.number}`);
      expect(page).toContain(item.detail.title);
    }
  });

  test('merged PR page shows merged status', () => {
    const merged = DEMO_ITEMS.find(
      (i) => i.kind === 'pr' && (i.detail as { merged?: boolean }).merged,
    );
    expect(merged).toBeDefined();
    const page = renderItemPage(merged!);
    expect(page).toContain('status: "merged"');
  });

  test('draft PR page shows draft status', () => {
    const draft = DEMO_ITEMS.find((i) => i.kind === 'pr' && i.detail.draft);
    expect(draft).toBeDefined();
    const page = renderItemPage(draft!);
    expect(page).toContain('status: "draft"');
  });

  test('renderRepoCard renders every fixture repo offline', () => {
    for (const repo of DEMO_REPOS) {
      const card = renderRepoCard(repo.full_name, repo);
      expect(card).toContain('kind: repo');
      expect(card).toContain(`repo: "${repo.full_name}"`);
      expect(card).toContain(`https://github.com/${repo.full_name}`);
    }
  });

  test('itemPagePath / repoCardPath produce the gh/<repo>/ layout', () => {
    const dir = makeOutDir();
    try {
      const itemPath = itemPagePath(dir, 'alice-example/sample-app', 12);
      expect(itemPath).toBe(join(dir, 'gh', 'alice-example', 'sample-app', '12.md'));
      const cardPath = repoCardPath(dir, 'alice-example/sample-app');
      expect(cardPath).toBe(join(dir, 'gh', 'alice-example', 'sample-app', 'index.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('demo pages are writable through the same paths a sync uses', () => {
    const dir = makeOutDir();
    try {
      const item = DEMO_ITEMS[0];
      const itemPath = itemPagePath(dir, item.repo, item.number);
      const cardPath = repoCardPath(dir, item.repo);
      expect(existsSync(itemPath)).toBe(false);
      expect(existsSync(cardPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('empty-body issue page gets a matchable Context block', () => {
    const empty = DEMO_ITEMS.find((i) => i.detail.body === null);
    expect(empty).toBeDefined();
    const page = renderItemPage(empty!);
    expect(page).toContain('_no description_');
    expect(page).toContain('## Context');
    expect(page).toContain('- labels: bug, test-flake');
    expect(page).toContain('- milestone: v0.3.0');
    expect(page).toContain('- assignees: bob');
    expect(page).toContain('- repo: alice-example/sample-app');
  });

  test('populated items do not get a Context block (no churn)', () => {
    const filled = DEMO_ITEMS.find((i) => i.detail.body !== null);
    expect(filled).toBeDefined();
    const page = renderItemPage(filled!);
    expect(page).not.toContain('## Context');
  });

  test('privacy: no real-world names in the fixture', () => {
    const joined = JSON.stringify({ items: DEMO_ITEMS, repos: DEMO_REPOS });
    for (const bad of ['veltri', 'Veltri', 'garrytan', 'Garry-s-List', 'acme']) {
      expect(joined).not.toContain(bad);
    }
  });
});

// ─── runSourcesDemo CLI arg handling ───
//
// Reality notes (pinned against src/commands/sources-demo.ts):
//   - Signature is runSourcesDemo(engine, args) — the engine param is unused
//     (`_engine`; the demo is fully offline), so tests pass a null stand-in.
//   - args[0] must be the literal 'github' (except a leading --help/-h, which
//     prints usage and returns BEFORE the positional check).
//   - All usage errors console.error + process.exit(2) — code 2, not 1.

const NO_ENGINE = null as unknown as BrainEngine; // never touched by the demo

interface DemoRunResult {
  stdout: string;
  stderr: string;
  /** undefined = returned without calling process.exit. */
  exitCode: number | undefined;
}

async function runDemo(args: string[]): Promise<DemoRunResult> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  (process.exit as unknown) = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__EXIT__');
  }) as never;
  try {
    await runSourcesDemo(NO_ENGINE, args);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== '__EXIT__') throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

/** All regular files under dir, recursively (relative paths). */
function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((d) => d.isFile())
    .map((d) => join((d as { parentPath?: string; path?: string }).parentPath ?? (d as { path?: string }).path ?? '', d.name));
}

describe('gbrain sources demo github — CLI', () => {
  test('--dir + --limit 2 writes under --dir only, honors the limit, prints guidance', async () => {
    const dir = makeOutDir();
    const cwdDefault = join(process.cwd(), 'gbrain-demo');
    const cwdDefaultExistedBefore = existsSync(cwdDefault);
    try {
      const r = await runDemo(['github', '--dir', dir, '--limit', '2']);
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toBe('');

      // Limit honored: exactly the first 2 fixture items, plus one repo card
      // per distinct repo among them.
      const items = DEMO_ITEMS.slice(0, 2);
      const repos = new Set(items.map((i) => i.repo));
      for (const item of items) {
        expect(existsSync(itemPagePath(dir, item.repo, item.number))).toBe(true);
      }
      for (const repo of repos) {
        expect(existsSync(repoCardPath(dir, repo))).toBe(true);
      }
      // Item 3+ NOT rendered.
      const third = DEMO_ITEMS[2];
      expect(existsSync(itemPagePath(dir, third.repo, third.number))).toBe(false);
      // Total file count = items + repo cards, nothing extra.
      expect(listFiles(dir).length).toBe(items.length + repos.size);

      // Never writes to cwd's default ./gbrain-demo when --dir is given.
      expect(existsSync(cwdDefault)).toBe(cwdDefaultExistedBefore);

      // Guidance copy.
      expect(r.stdout).toContain(`wrote ${items.length} item pages + ${repos.size} repo cards to ${dir}`);
      expect(r.stdout).toContain('no network, no token, no brain required');
      expect(r.stdout).toContain('gbrain sources add gh --kind github --scope auto');
      expect(r.stdout).toContain('docs/guides/github-source.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--limit 0 → usage error (exit 2), nothing written', async () => {
    const dir = makeOutDir();
    try {
      const r = await runDemo(['github', '--dir', dir, '--limit', '0']);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--limit must be a positive integer');
      expect(listFiles(dir)).toEqual([]); // parse fails before any mkdir/write
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--limit abc → usage error (exit 2), nothing written', async () => {
    const dir = makeOutDir();
    try {
      const r = await runDemo(['github', '--dir', dir, '--limit', 'abc']);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--limit must be a positive integer');
      expect(listFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dangling --dir → usage error (exit 2), nothing written', async () => {
    const cwdDefault = join(process.cwd(), 'gbrain-demo');
    const cwdDefaultExistedBefore = existsSync(cwdDefault);
    const r = await runDemo(['github', '--dir']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Usage: gbrain sources demo github');
    expect(existsSync(cwdDefault)).toBe(cwdDefaultExistedBefore);
  });

  test('missing "github" positional → usage error (exit 2)', async () => {
    const dir = makeOutDir();
    try {
      const r = await runDemo(['--dir', dir]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('Usage: gbrain sources demo github');
      expect(listFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--help prints usage and writes nothing', async () => {
    // Reality: --help is only honored as args[0] (before the 'github'
    // positional check); `github --help` would be an unknown-option error.
    const cwdDefault = join(process.cwd(), 'gbrain-demo');
    const cwdDefaultExistedBefore = existsSync(cwdDefault);
    const r = await runDemo(['--help']);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('Usage: gbrain sources demo github [--dir <path>] [--limit <n>]');
    expect(r.stderr).toBe('');
    expect(existsSync(cwdDefault)).toBe(cwdDefaultExistedBefore);
  });
});

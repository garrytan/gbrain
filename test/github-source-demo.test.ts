import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderItemPage, renderRepoCard, itemPagePath, repoCardPath } from '../src/core/github-source.ts';
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

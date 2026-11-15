/**
 * scripts/lib/gh-issue.ts createIssue + every issue filer in the repository.
 *
 * Protects: each issue our own automation opens carries the `agent-filed`
 * label, so CONTRIBUTING.md's "community issues" search (open issues without
 * that label) shows only community reports. The CI filers (nightly-issue.ts,
 * master-red.ts, ci-health-report.ts) open issues through createIssue, and
 * upgrade-matrix.ts names the label itself; the ratchet below fails if a
 * script or workflow opens an issue any other way.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AGENT_FILED_LABEL, createIssue, type GitHubClient } from '../../scripts/lib/gh-issue.ts';

const ROOT = join(import.meta.dir, '../..');

function recorder() {
  const calls: Array<{ method: string; path: string; body: { labels?: string[] } }> = [];
  const client: GitHubClient = {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body: body as { labels?: string[] } });
      return { number: 1, title: 't', state: 'open' } as T;
    },
  };
  return { client, calls };
}

function files(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

describe('agent-filed label', () => {
  test('createIssue adds the label to the caller\'s labels, once', async () => {
    expect(AGENT_FILED_LABEL).toBe('agent-filed');
    const { client, calls } = recorder();
    await createIssue(client, 'Nightly red: X', 'body', ['nightly-red']);
    await createIssue(client, 'Flake: y', 'body', ['flake', 'agent-filed']);
    await createIssue(client, 'z', 'body', []);
    expect(calls.map(c => [c.method, c.path, c.body.labels])).toEqual([
      ['POST', 'repos/{repo}/issues', ['nightly-red', 'agent-filed']],
      ['POST', 'repos/{repo}/issues', ['flake', 'agent-filed']],
      ['POST', 'repos/{repo}/issues', ['agent-filed']],
    ]);
  });

  test('no script or workflow opens an issue without the label', () => {
    const candidates = [
      ...files(join(ROOT, 'scripts'), p => /\.(ts|sh|js|mjs)$/.test(p)),
      ...files(join(ROOT, '.github'), p => /\.ya?ml$/.test(p)),
    ];
    const offenders: string[] = [];
    for (const p of candidates) {
      const rel = relative(ROOT, p);
      const text = readFileSync(p, 'utf8');
      if (/gh\s+issue\s+create|issues\.create\(/.test(text)) offenders.push(`${rel}: gh issue create / issues.create`);
      if (rel === 'scripts/lib/gh-issue.ts') continue;
      if (/['"`]POST['"`],\s*['"`](repos\/\{repo\})?\/?issues['"`]/.test(text) && !text.includes('AGENT_FILED_LABEL')) offenders.push(`${rel}: POST to the issues collection without AGENT_FILED_LABEL`);
    }
    expect(offenders).toEqual([]);
    expect(readFileSync(join(ROOT, 'scripts/upgrade-matrix.ts'), 'utf8')).toContain('labels: [ISSUE_LABEL, AGENT_FILED_LABEL]');
    for (const filer of ['scripts/nightly-issue.ts', 'scripts/lib/master-red.ts', 'scripts/ci-health-report.ts']) {
      expect(readFileSync(join(ROOT, filer), 'utf8')).toContain('createIssue(client');
    }
  });
});

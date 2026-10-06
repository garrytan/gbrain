/**
 * .github/workflows/fix-wave-closeout.yml + scripts/fix-wave-closeout.ts — closing what a fix wave superseded.
 *
 * Protects: when a same-repo fix wave merges, every open PR on a `Supersedes #N`
 * line is closed with one thank-you comment linking the wave, and nothing else
 * is touched. Regressions it catches: closing PRs a wave merely mentions, acting
 * on an unmerged or fork PR, commenting twice on a re-run, claiming credit the
 * wave body does not give, and the workflow growing a PR checkout or a
 * pull_request trigger that would run the PR's own copy.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  COMMENT_MARKER, closeoutMessage, isMergedWave, runCloseout, supersededNumbers,
  type CloseoutClient, type CloseoutEvent, type PullInfo,
} from '../../scripts/fix-wave-closeout.ts';

const ROOT = join(import.meta.dir, '..', '..');
const REPO = { id: 1, full_name: 'garrytan/gbrain' };

function wave(body: string, over: Partial<NonNullable<CloseoutEvent['pull_request']>> = {}): CloseoutEvent {
  return { action: 'closed', pull_request: { number: 9000, title: 'v0.60.70.0 fix wave 9', merged: true, body, head: { repo: REPO }, base: { repo: REPO, ref: 'master' }, ...over } };
}

function fakeClient(pulls: Record<number, PullInfo>, comments: Record<number, string[]> = {}) {
  const calls: string[] = [];
  const client: CloseoutClient = {
    getPull: async n => { calls.push(`get ${n}`); return pulls[n] ?? null; },
    commentBodies: async n => comments[n] ?? [],
    createComment: async (n, body) => { calls.push(`comment ${n}`); (comments[n] ??= []).push(body); },
    close: async n => { calls.push(`close ${n}`); pulls[n] = { ...pulls[n]!, state: 'closed' }; },
  };
  return { client, calls, comments };
}

async function run(event: CloseoutEvent, client: CloseoutClient, dryRun = false) {
  const lines: string[] = [];
  const summary: string[] = [];
  const code = await runCloseout(event, client, { line: s => lines.push(s), summary: s => summary.push(s) }, dryRun);
  return { code, out: lines.join('\n'), summary: summary.join('') };
}

const open = (number: number, login = 'alice-example'): PullInfo => ({ number, state: 'open', login, title: `fix ${number}` });

describe('supersededNumbers', () => {
  test('reads bare, bulleted, bold and list forms, in order, without duplicates', () => {
    const body = [
      'Fixes #100.',
      'Supersedes #5085',
      '- Supersedes #5089, #5096 and #5107',
      '* **Supersedes:** #5113',
      'supersedes #5085 again',
    ].join('\n');
    expect(supersededNumbers(body, 9000)).toEqual([5085, 5089, 5096, 5107, 5113]);
  });

  test('ignores mentions outside a leading Supersedes list', () => {
    const body = [
      'Fixes #5490. Supersedes #5140, which no longer merges.',
      'Supersedes #5140, which conflicts with #5000 in gateway.ts',
      '| #5133 | adopted scope |',
      'This supersedes nothing: see #4954.',
    ].join('\n');
    expect(supersededNumbers(body, 9000)).toEqual([5140]);
  });

  test('never names the wave itself and tolerates an empty body', () => {
    expect(supersededNumbers('Supersedes #9000 and #1', 9000)).toEqual([1]);
    expect(supersededNumbers(null, 9000)).toEqual([]);
  });
});

describe('fix-wave closeout run', () => {
  test('closes each open superseded PR with one comment linking the wave', async () => {
    const { client, calls, comments } = fakeClient({ 5085: open(5085), 5089: open(5089, 'bob-example') });
    const r = await run(wave('Supersedes #5085 and #5089\n\nContributed by @alice-example'), client);
    expect(r.code).toBe(0);
    expect(calls).toEqual(['get 5085', 'comment 5085', 'close 5085', 'get 5089', 'comment 5089', 'close 5089']);
    expect(comments[5085]![0]).toContain(COMMENT_MARKER);
    expect(comments[5085]![0]).toContain('Fix-wave PR #9000 (v0.60.70.0 fix wave 9)');
    expect(comments[5085]![0]).toContain('`Contributed by @alice-example`');
    expect(comments[5089]![0]).not.toContain('Contributed by');
    expect(r.summary).toContain('#5085: closed (@alice-example, credited)');
    expect(r.summary).toContain('#5089: closed (@bob-example)');
  });

  test('skips issues, closed PRs and an existing comment, and never fails the run', async () => {
    const { client, calls } = fakeClient(
      { 5140: { ...open(5140), state: 'closed' }, 5156: open(5156) },
      { 5156: [`${COMMENT_MARKER}\nalready said thanks`] },
    );
    const r = await run(wave('Supersedes #5134, #5140 and #5156'), client);
    expect(r.code).toBe(0);
    expect(calls).toEqual(['get 5134', 'get 5140', 'get 5156', 'close 5156']);
    expect(r.out).toContain('#5134: skipped, not a pull request');
    expect(r.out).toContain('#5140: skipped, already closed');
  });

  test('a failed close is a warning with a fix, and later PRs still close', async () => {
    const { client, calls } = fakeClient({ 1: open(1), 2: open(2) });
    const failing: CloseoutClient = { ...client, close: async n => { if (n === 1) throw new Error('GitHub API PATCH /pulls/1 returned 403'); await client.close(n); } };
    const r = await run(wave('Supersedes #1, #2'), failing);
    expect(r.code).toBe(0);
    expect(r.out).toContain('::warning title=Fix-wave closeout::Could not close #1.');
    expect(r.out).toContain('Fix: close it by hand');
    expect(calls).toContain('close 2');
  });

  test('does nothing for an unmerged PR, a fork PR or a deleted fork', async () => {
    const forkRepo = { id: 2, full_name: 'alice-example/gbrain' };
    for (const event of [
      wave('Supersedes #1', { merged: false }),
      wave('Supersedes #1', { head: { repo: forkRepo } }),
      wave('Supersedes #1', { head: { repo: null } }),
      wave('Supersedes #1', { head: { repo: { id: 2, full_name: 'garrytan/gbrain' } } }),
    ]) {
      const { client, calls } = fakeClient({ 1: open(1) });
      expect(isMergedWave(event)).toBe(false);
      await run(event, client);
      expect(calls).toEqual([]);
    }
  });

  test('--dry-run reads but never writes', async () => {
    const { client, calls } = fakeClient({ 1: open(1) });
    const r = await run(wave('Supersedes #1'), client, true);
    expect(calls).toEqual(['get 1']);
    expect(r.out).toContain('#1: would close (@alice-example)');
  });

  test('the message thanks the contributor and invites a follow-up', () => {
    const m = closeoutMessage('alice-example', 9000, 'wave 9', false);
    expect(m.startsWith(COMMENT_MARKER)).toBe(true);
    expect(m).toContain('Thank you, @alice-example.');
    expect(m).toContain('not because anything was wrong with it');
    expect(m).toContain("reply here with what's missing");
  });
});

describe('fix-wave-closeout workflow', () => {
  const wf = load(readFileSync(join(ROOT, '.github', 'workflows', 'fix-wave-closeout.yml'), 'utf8')) as {
    on: Record<string, { branches?: string[]; types?: string[] }>;
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; permissions: Record<string, string>; steps: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }> }>;
  };

  test('runs only from the default branch on a merged same-repo PR into master', () => {
    expect(Object.keys(wf.on)).toEqual(['pull_request_target']);
    expect(wf.on.pull_request_target!.branches).toEqual(['master']);
    expect(wf.on.pull_request_target!.types).toEqual(['closed']);
    const job = wf.jobs['close-superseded']!;
    expect(job.if).toContain('github.event.pull_request.merged == true');
    expect(job.if).toContain("github.event.pull_request.head.repo.full_name == 'garrytan/gbrain'");
  });

  test('checks out only the script, never PR code, with least privilege', () => {
    expect(wf.permissions).toEqual({});
    const job = wf.jobs['close-superseded']!;
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    const checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with).toMatchObject({ 'persist-credentials': false, 'sparse-checkout': 'scripts/fix-wave-closeout.ts' });
    expect(checkout.with).not.toHaveProperty('ref');
    expect(checkout.with).not.toHaveProperty('repository');
    expect(job.steps.flatMap(s => s.run ? [s.run] : [])).toEqual(['bun scripts/fix-wave-closeout.ts']);
  });
});

/**
 * scripts/release-gate.ts + release.yml wiring: publication and the
 * latest-stable move wait for Test and E2E Tests success on the release
 * commit; a failed run publishes nothing with the next step; a run cancelled
 * by a newer push is followed to the next master commit with the same
 * VERSION (or marks the version superseded); dispatch backfills through the
 * same gate; non-master refs are refused.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { evaluate, gate, GATED, type GateDeps, type GateRun } from '../../scripts/release-gate.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const run = (id: number, n: number, sha: string, status: string, conclusion: string | null, attempt = 1): GateRun => ({ id, run_number: n, run_attempt: attempt, status, conclusion, head_sha: sha, head_branch: 'master', event: 'push' });

function deps(runs: Record<string, GateRun[]>, versions: Record<string, string> = {}, outside: string[] = []): GateDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async runsFor(file, sha) { calls.push(`runs ${file} ${sha.slice(0, 1)}`); return (runs[file] ?? []).filter(r => r.head_sha === sha); },
    async newerRuns(file, after) { return (runs[file] ?? []).filter(r => r.run_number > after); },
    async versionAt(sha) { return versions[sha] ?? '0.60.70.0'; },
    async contains(_base, head) { return !outside.includes(head); },
  };
}

describe('release gate', () => {
  test('publishes the release commit only when Test and E2E Tests both succeeded on it', async () => {
    expect(GATED.map(g => g.file)).toEqual(['test.yml', 'e2e.yml']);
    const green = deps({ 'test.yml': [run(1, 10, A, 'completed', 'success')], 'e2e.yml': [run(2, 20, A, 'completed', 'success')] });
    expect(await evaluate(green, A, '0.60.70.0')).toMatchObject({ kind: 'publish', sha: A });
    const pending = deps({ 'test.yml': [run(1, 10, A, 'in_progress', null)], 'e2e.yml': [run(2, 20, A, 'completed', 'success')] });
    expect(await evaluate(pending, A, '0.60.70.0')).toMatchObject({ kind: 'wait' });
    const missing = deps({ 'e2e.yml': [run(2, 20, A, 'completed', 'success')] });
    expect((await evaluate(missing, A, '0.60.70.0')).why).toContain('Test has no push run yet');
  });

  test('a failed run publishes nothing and names the repair and the backfill command', async () => {
    const red = deps({ 'test.yml': [run(1, 10, A, 'completed', 'failure')], 'e2e.yml': [run(2, 20, A, 'completed', 'success')] });
    const v = await evaluate(red, A, '0.60.70.0');
    expect(v.kind).toBe('fail');
    if (v.kind !== 'fail') return;
    expect(v.why).toContain('v0.60.70.0 is not published and latest-stable does not move');
    expect(v.next).toContain('Master red: Test');
    expect(v.next).toContain('gh workflow run release.yml --ref master');
    const rerunGreen = deps({ 'test.yml': [run(1, 10, A, 'completed', 'failure'), run(1, 10, A, 'completed', 'success', 2)], 'e2e.yml': [run(2, 20, A, 'completed', 'success')] });
    expect((await evaluate(rerunGreen, A, '0.60.70.0')).kind).toBe('publish');
  });

  test('a run cancelled by a newer push is followed to the next master commit with the same VERSION, which is published', async () => {
    const d = deps({
      'test.yml': [run(1, 10, A, 'completed', 'cancelled'), run(3, 11, B, 'completed', 'success')],
      'e2e.yml': [run(2, 20, A, 'completed', 'success'), run(4, 21, B, 'completed', 'success')],
    });
    const v = await evaluate(d, A, '0.60.70.0');
    expect(v).toMatchObject({ kind: 'publish', sha: B });
    expect(v.why).toContain('same VERSION');
    const notYet = deps({ 'test.yml': [run(1, 10, A, 'completed', 'cancelled')], 'e2e.yml': [run(2, 20, A, 'completed', 'success')] });
    expect((await evaluate(notYet, A, '0.60.70.0')).why).toContain('waiting for the newer push-to-master run');
    const redSuccessor = deps({ 'test.yml': [run(1, 10, A, 'completed', 'cancelled'), run(3, 11, B, 'completed', 'failure')], 'e2e.yml': [run(4, 21, B, 'completed', 'success')] });
    expect(await evaluate(redSuccessor, A, '0.60.70.0')).toMatchObject({ kind: 'fail', sha: B });
  });

  test('a cancellation by a push that moved VERSION marks this version superseded; a successor that lacks the release commit fails', async () => {
    const moved = deps({ 'test.yml': [run(1, 10, A, 'completed', 'cancelled'), run(3, 11, B, 'in_progress', null)], 'e2e.yml': [] }, { [B]: '0.60.71.0' });
    expect(await evaluate(moved, A, '0.60.70.0')).toMatchObject({ kind: 'superseded', sha: B });
    const stray = deps({ 'test.yml': [run(1, 10, A, 'completed', 'cancelled'), run(3, 11, C, 'completed', 'success')], 'e2e.yml': [] }, {}, [C]);
    expect((await evaluate(stray, A, '0.60.70.0')).kind).toBe('fail');
  });

  test('the poller waits while CI runs and fails with the backfill command at its deadline (dispatch backfill uses the same gate)', async () => {
    let t = 0;
    const lines: string[] = [];
    const states = [run(1, 10, A, 'queued', null), run(1, 10, A, 'in_progress', null), run(1, 10, A, 'completed', 'success')];
    let i = 0;
    const d: GateDeps = {
      async runsFor(file) { return file === 'test.yml' ? [states[Math.min(i++, 2)]!] : [run(2, 20, A, 'completed', 'success')]; },
      async newerRuns() { return []; }, async versionAt() { return '0.60.70.0'; }, async contains() { return true; },
    };
    const v = await gate(d, { sha: A, version: '0.60.70.0', timeoutMs: 10 * 60_000, pollMs: 60_000, log: l => lines.push(l), sleep: async ms => { t += ms; }, now: () => t });
    expect(v.kind).toBe('publish');
    expect(lines).toHaveLength(2);
    const stuck = deps({ 'test.yml': [run(1, 10, A, 'in_progress', null)], 'e2e.yml': [] });
    t = 0;
    const late = await gate(stuck, { sha: A, version: '0.60.70.0', timeoutMs: 3 * 60_000, pollMs: 60_000, log: () => {}, sleep: async ms => { t += ms; }, now: () => t });
    expect(late.kind).toBe('fail');
    if (late.kind === 'fail') expect(late.next).toContain('gh workflow run release.yml --ref master');
  });
});

describe('release.yml waits for the CI gate', () => {
  const wf = load(readFileSync(join(import.meta.dir, '../../.github/workflows/release.yml'), 'utf8')) as { on: Record<string, unknown>; jobs: Record<string, { needs?: string[] | string; if?: string; steps: Array<{ run?: string; with?: Record<string, string>; env?: Record<string, string> }>; permissions?: Record<string, string> }> };
  test('build, release, latest-stable and the publish jobs need ci-gate and use its commit', () => {
    expect(wf.on.workflow_dispatch).toBeDefined();
    const gateJob = wf.jobs['ci-gate']!;
    expect(gateJob.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(gateJob.steps.some(s => s.run?.includes('bun scripts/release-gate.ts --sha "$GITHUB_SHA"') && s.run.includes('--ref "$GITHUB_REF"'))).toBe(true);
    for (const job of ['build', 'release', 'publish-template', 'publish-codex-plugin']) {
      expect(wf.jobs[job]!.needs).toContain('ci-gate');
      expect(wf.jobs[job]!.if).toContain("needs.ci-gate.outputs.publish == 'true'");
      expect(wf.jobs[job]!.steps[0]!.with?.ref).toBe('${{ needs.ci-gate.outputs.sha }}');
    }
    const steps = wf.jobs.release!.steps;
    expect(steps.find(s => s.with?.target_commitish)!.with!.target_commitish).toBe('${{ needs.ci-gate.outputs.sha }}');
    const advance = steps.find(s => s.run?.includes('refs/tags/latest-stable'))!;
    expect(advance.run).toContain('+${RELEASE_SHA}:refs/tags/latest-stable');
    expect(advance.env!.RELEASE_SHA).toBe('${{ needs.ci-gate.outputs.sha }}');
  });

  test('publish-template takes the template tree hash from the gated commit, not github.sha', () => {
    const push = wf.jobs['publish-template']!.steps.find(s => s.run?.includes('git push --force'))!;
    expect(push.env!.RELEASE_SHA).toBe('${{ needs.ci-gate.outputs.sha }}');
    expect(push.run).toContain('TEMPLATE_TREE_HASH="$(git rev-parse "${RELEASE_SHA}:templates/bootstrap/template-repo" 2>/dev/null || true)"');
    expect(push.run!.indexOf('TEMPLATE_TREE_HASH="$(git rev-parse')).toBeLessThan(push.run!.indexOf('cd /tmp/template-tree'));
    expect(push.env!.TEMPLATE_TREE_HASH).toBeUndefined();
    expect(readFileSync(join(import.meta.dir, '../../.github/workflows/release.yml'), 'utf8')).not.toContain('template_tree_hash');
  });
});

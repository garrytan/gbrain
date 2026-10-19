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
import { deflateRawSync } from 'node:zlib';
import { load } from 'js-yaml';
import { apiDeps, evaluate, gate, GATED, reuseOutputs, type GateDeps, type GateRun, type Provenance } from '../../scripts/release-gate.ts';
import type { GitHubClient } from '../../scripts/lib/gh-issue.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const run = (id: number, n: number, sha: string, status: string, conclusion: string | null, attempt = 1): GateRun => ({ id, run_number: n, run_attempt: attempt, status, conclusion, head_sha: sha, head_branch: 'master', event: 'push' });

function deps(runs: Record<string, GateRun[]>, versions: Record<string, string> = {}, outside: string[] = [], reused: Record<number, Provenance> = {}): GateDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async runsFor(file, sha) { calls.push(`runs ${file} ${sha.slice(0, 1)}`); return (runs[file] ?? []).filter(r => r.head_sha === sha); },
    async newerRuns(file, after) { return (runs[file] ?? []).filter(r => r.run_number > after); },
    async versionAt(sha) { return versions[sha] ?? '0.60.70.0'; },
    async contains(_base, head) { return !outside.includes(head); },
    async provenance(_file, r) { return reused[r.id] ?? { reused: false }; },
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

  test('a publish names the full-suite run each workflow reused, and writes both ids', async () => {
    const d = deps({ 'test.yml': [run(1, 10, A, 'completed', 'success')], 'e2e.yml': [run(2, 20, A, 'completed', 'success')] }, {}, [], { 1: { reused: true, run_id: 900, run_attempt: 2, sha: B } });
    const v = await evaluate(d, A, '0.60.70.0');
    expect(v).toMatchObject({ kind: 'publish', sha: A, sources: [{ workflow: 'Test', run_id: 1, reused: { run_id: 900, run_attempt: 2, sha: B } }, { workflow: 'E2E Tests', run_id: 2 }] });
    expect(v.why).toContain('Test reused full-suite run 900 attempt 2');
    expect(v.why).toContain('E2E Tests ran in full in run 2');
    if (v.kind !== 'publish') return;
    expect(reuseOutputs(v.sources)).toBe('test_reused_run_id=900\ne2e_reused_run_id=\n');
  });

  test('a reused push run whose reuse record cannot be read publishes nothing and names the re-run', async () => {
    const d = deps({ 'test.yml': [run(1, 10, A, 'completed', 'success')], 'e2e.yml': [run(2, 20, A, 'completed', 'success')] }, {}, [], { 2: { problem: "run 2 has no 'reused-full-suite' artifact" } });
    const v = await evaluate(d, A, '0.60.70.0');
    expect(v.kind).toBe('fail');
    if (v.kind !== 'fail') return;
    expect(v.why).toContain('E2E Tests run 2');
    expect(v.why).toContain("no 'reused-full-suite' artifact");
    expect(v.why).toContain('v0.60.70.0 is not published');
    expect(v.next).toContain('gh run rerun 2');
    expect(v.next).toContain('gh workflow run release.yml --ref master');
  });

  test('the poller waits while CI runs and fails with the backfill command at its deadline (dispatch backfill uses the same gate)', async () => {
    let t = 0;
    const lines: string[] = [];
    const states = [run(1, 10, A, 'queued', null), run(1, 10, A, 'in_progress', null), run(1, 10, A, 'completed', 'success')];
    let i = 0;
    const d: GateDeps = {
      async runsFor(file) { return file === 'test.yml' ? [states[Math.min(i++, 2)]!] : [run(2, 20, A, 'completed', 'success')]; },
      async newerRuns() { return []; }, async versionAt() { return '0.60.70.0'; }, async contains() { return true; },
      async provenance() { return { reused: false }; },
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

/** A one-entry zip, enough for readZipEntry. */
function zipOf(name: string, content: string): Uint8Array {
  const data = Buffer.from(content);
  const body = deflateRawSync(data);
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28); central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(30 + file.length + body.length, 16);
  return new Uint8Array(Buffer.concat([local, file, body, central, file, end]));
}

describe('release gate reads reuse provenance from the push run', () => {
  const client = (jobs: Array<{ name: string; conclusion: string | null }>, record?: unknown): GitHubClient & { paths: string[] } => {
    const paths: string[] = [];
    return {
      paths,
      async request<T>(_m: string, path: string): Promise<T> {
        paths.push(path);
        if (path.includes('/attempts/3/jobs')) return { total_count: jobs.length, jobs } as T;
        if (path.includes('/artifacts?name=reused-full-suite')) return { artifacts: record === undefined ? [] : [{ id: 77, name: 'reused-full-suite', expired: false }] } as T;
        throw new Error(`unexpected ${path}`);
      },
      async download() { return zipOf('reuse.json', JSON.stringify(record)); },
    };
  };
  const pushRun = run(5, 50, A, 'completed', 'success', 3);
  const rec = { reuse: true, workflow: 'Test', push_sha: A, tree: C, source_run_id: 900, source_run_attempt: 1, source_sha: B };

  test('a succeeded reused-full-suite job in the latest attempt yields the validated source run', async () => {
    const c = client([{ name: 'test-status', conclusion: 'success' }, { name: 'reused-full-suite', conclusion: 'success' }], rec);
    expect(await apiDeps(c).provenance('test.yml', pushRun)).toEqual({ reused: true, run_id: 900, run_attempt: 1, sha: B });
    expect(c.paths[0]).toBe('repos/{repo}/actions/runs/5/attempts/3/jobs?per_page=100&page=1');
  });

  test('no reused-full-suite job, or a skipped one, means the push ran in full', async () => {
    expect(await apiDeps(client([{ name: 'test-status', conclusion: 'success' }])).provenance('test.yml', pushRun)).toEqual({ reused: false });
    expect(await apiDeps(client([{ name: 'reused-full-suite', conclusion: 'skipped' }])).provenance('test.yml', pushRun)).toEqual({ reused: false });
  });

  test('a reused job without a valid record for this workflow and push is a problem, never a full run', async () => {
    const missing = await apiDeps(client([{ name: 'reused-full-suite', conclusion: 'success' }])).provenance('test.yml', pushRun);
    expect('problem' in missing && missing.problem).toContain("no 'reused-full-suite' artifact");
    const otherPush = await apiDeps(client([{ name: 'reused-full-suite', conclusion: 'success' }], { ...rec, push_sha: B })).provenance('test.yml', pushRun);
    expect('problem' in otherPush && otherPush.problem).toContain('not ' + A);
    const otherWorkflow = await apiDeps(client([{ name: 'reused-full-suite', conclusion: 'success' }], rec)).provenance('e2e.yml', pushRun);
    expect('problem' in otherWorkflow && otherWorkflow.problem).toContain('not E2E Tests');
    const failed = await apiDeps(client([{ name: 'reused-full-suite', conclusion: 'failure' }], rec)).provenance('test.yml', pushRun);
    expect('problem' in failed && failed.problem).toContain('concluded failure');
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

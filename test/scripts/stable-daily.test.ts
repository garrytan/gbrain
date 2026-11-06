/**
 * .github/workflows/stable-daily.yml + scripts/stable-daily.ts — the daily
 * stable check (R74), and the schedule-only authorization it adds to
 * scripts/promote-stable.ts.
 *
 * Protects: a scheduled run promotes only with a reason (a released
 * stable:important fix that stable lacks, or the 7-day weekly floor), only a
 * release newer than stable whose exact tree passed the soak with every
 * integrity gate clean, only a release that carries the fix on the
 * important-only path, and never while stable is a rollback or the kill switch
 * is off; with nothing promotable it dispatches at most one soak and never
 * retries a failed one; a dry run writes nothing; and only a schedule event of
 * stable-daily.yml skips the maintainer check.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { promote, renderTagMessage, scheduleAuthorized, Refusal, type GitResult } from '../../scripts/promote-stable.ts';
import { daily, integrityFailures, parseRecord, type DailyDeps, type Scoreboard, type SoakRunRow } from '../../scripts/stable-daily.ts';
import { parseStableRecord } from '../../src/core/stable-channel.ts';

const ROOT = join(import.meta.dir, '..', '..');
const REPO = 'garrytan/gbrain';
const NOW = new Date('2026-11-10T13:17:00Z');
const sha = (n: number) => String(n).padStart(40, 'c');
const tree = (n: number) => String(n).padStart(40, 'e');
const CLEAN: Scoreboard[] = ['rtt2', 'rtt65'].map(label => ({
  label,
  gates: ['privacy_leaks', 'read_errors', 'version_skew', 'residents_alive', 'session_refusals', 'freshness_p95'].map(id => ({ id, pass: id === 'freshness_p95' ? false : true })),
}));
const ok = (stdout = ''): GitResult => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
const fail: GitResult = { code: 1, stdout: '', stderr: 'fatal: bad revision' };

interface World {
  /** Linear history: commit n is an ancestor of every commit >= n. */
  head: number;
  releases: Record<string, number>;
  stable: { version: string; commit: number; message: string };
  importantPrs?: Array<{ number: number; merge: number }>;
  runs?: Array<SoakRunRow & { boards?: Scoreboard[] }>;
  autoPromote?: string;
  dryRun?: boolean;
  scheduled?: boolean;
  /** The published stable.json; default: a record naming the current stable. null: none published yet. */
  published?: string | null;
}

const stableMessage = (version: string, promotedAt: string, rollback = false) =>
  `gbrain stable channel: v${version}\n\nversion: ${version}\npromoted_at: ${promotedAt}\nrollback: ${rollback}\nreason: ${rollback ? 'sync regression' : '-'}\n`;

function world(w: World) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const pushes: string[] = [];
  const api: string[] = [];
  const logs: string[] = [];
  const tags: Record<string, { commit: number; object: string; message?: string }> = {
    stable: { commit: w.stable.commit, object: 'tagobj-stable', message: w.stable.message },
    [`stable-v${w.stable.version}`]: { commit: w.stable.commit, object: 'tagobj-record' },
  };
  for (const [v, c] of Object.entries(w.releases)) tags[`v${v}`] = { commit: c, object: sha(c) };
  const commitOf = (spec: string): number | null => {
    const name = spec.replace(/^refs\/tags\//, '');
    if (tags[name]) return tags[name]!.commit;
    const n = Number.parseInt(spec.replace(/^c+/, ''), 10);
    return /^c*\d+$/.test(spec) && spec.length === 40 && n <= w.head ? n : null;
  };
  /** The evidence record promote() commits (GBRA-224 W1): blob, tree and commit objects, and the pushed stable-record head. */
  const objects: Record<string, string> = {};
  const record: { head?: string } = {};
  const published = w.published === undefined ? JSON.stringify({ schema: 1, version: w.stable.version, commit: sha(w.stable.commit), known_bad: [] }) : w.published;
  if (published !== null) { objects['rec-published'] = published; record.head = 'rec-published'; }
  const git = async (args: string[], input?: string): Promise<GitResult> => {
    const [cmd, ...rest] = args;
    if (cmd === 'hash-object') { const id = `blob-${Object.keys(objects).length}`; objects[id] = input ?? ''; return ok(id); }
    if (cmd === 'mktree') { const id = `tree-${Object.keys(objects).length}`; objects[id] = objects[/blob (\S+)\tstable\.json/.exec(input ?? '')![1]!]!; return ok(id); }
    if (cmd === 'commit-tree') { const id = `rec-${Object.keys(objects).length}`; objects[id] = objects[rest[0]!]!; return ok(id); }
    if (cmd === 'show' && rest[0]!.endsWith(':stable.json')) { const body = objects[rest[0]!.replace(/:stable\.json$/, '')]; return body === undefined ? fail : ok(body); }
    if (cmd === 'rev-parse' && rest.at(-1) === 'refs/remotes/origin/stable-record^{commit}') return record.head ? ok(record.head) : fail;
    if (cmd === 'rev-parse') {
      const spec = rest.at(-1)!;
      const m = /^(.*?)(\^\{(commit|tree)\})?$/.exec(spec)!;
      const c = commitOf(m[1]!);
      if (c === null) return fail;
      if (m[3] === 'tree') return ok(tree(c));
      if (m[3] === 'commit') return ok(sha(c));
      const name = m[1]!.replace(/^refs\/tags\//, '');
      return ok(tags[name]?.object ?? sha(c));
    }
    if (cmd === 'for-each-ref') return ok(tags.stable!.message ?? '');
    if (cmd === 'tag' && rest[0] === '--list') return ok(Object.keys(tags).filter(t => t.startsWith('v')).join('\n'));
    if (cmd === 'tag' && rest[0] === '--points-at') {
      const c = commitOf(rest[1]!);
      return ok(Object.entries(tags).filter(([n, t]) => n.startsWith('v') && t.commit === c).map(([n]) => n).join('\n'));
    }
    if (cmd === 'tag' && rest[0] === '-a') {
      const [name, commit] = rest.slice(-2) as [string, string];
      tags[name] = { commit: commitOf(commit)!, object: `tagobj-${name}-new`, message: rest[rest.indexOf('-m') + 1] };
      return ok();
    }
    if (cmd === 'show') return ok(rest[0]!.replace(/^refs\/tags\/v/, '').replace(/:VERSION$/, ''));
    if (cmd === 'merge-base') {
      const a = commitOf(rest[1]!); const b = commitOf(rest[2]!);
      return a !== null && b !== null && a <= b ? ok() : fail;
    }
    if (cmd === 'push') {
      pushes.push(rest.join(' '));
      const head = rest.find(a => a.endsWith(':refs/heads/stable-record'));
      if (head) record.head = head.split(':')[0];
      return ok();
    }
    if (cmd === 'fetch') return ok();
    return fail;
  };
  const runs = w.runs ?? [];
  const deps: DailyDeps = {
    repo: REPO,
    actor: 'github-actions[bot]',
    scheduled: w.scheduled ?? true,
    soakWorkflow: 'production-soak.yml',
    autoPromote: w.autoPromote ?? '',
    dryRun: w.dryRun ?? false,
    async ghApi(path) {
      api.push(path);
      if (path.startsWith('search/issues')) return { items: (w.importantPrs ?? []).map(p => ({ number: p.number })) };
      const pull = /\/pulls\/(\d+)$/.exec(path);
      if (pull) return { merge_commit_sha: sha(w.importantPrs!.find(p => p.number === Number(pull[1]))!.merge) };
      if (path.includes('/actions/workflows/')) return { workflow_runs: runs };
      if (path.includes('/actions/runs/')) {
        const run = runs.find(r => path.endsWith(`/${r.id}`))!;
        return { status: run.status, conclusion: run.conclusion, path: '.github/workflows/production-soak.yml', head_sha: run.head_sha };
      }
      if (path.includes('/releases/tags/')) return { draft: false };
      if (path.endsWith('/permission')) return { permission: 'none' };
      throw new Error(`unexpected api ${path}`);
    },
    git,
    now: () => NOW,
    log: line => logs.push(line),
    summary: () => {},
    async ghPost(path, body) { posts.push({ path, body }); },
    async scoreboards(id) { return runs.find(r => r.id === id)?.boards ?? CLEAN; },
  };
  return { deps, posts, pushes, api, logs, tags, record: () => (record.head ? objects[record.head] : undefined) };
}

const soak = (id: number, commit: number, over: Partial<SoakRunRow> & { boards?: Scoreboard[] } = {}) =>
  ({ id, status: 'completed', conclusion: 'success', head_sha: sha(commit), html_url: `https://github.com/${REPO}/actions/runs/${id}`, ...over });

const base = (over: Partial<World> = {}): World => ({
  head: 6,
  releases: { '1.0.1': 1, '1.0.2': 2, '1.0.3': 3, '1.0.4': 4 },
  stable: { version: '1.0.1', commit: 1, message: stableMessage('1.0.1', '2026-11-08T05:17:00Z') },
  ...over,
});

describe('scheduleAuthorized', () => {
  test('only a schedule event of stable-daily.yml on a branch of this repository', () => {
    const env = (event: string, ref: string) => ({ GITHUB_EVENT_NAME: event, GITHUB_WORKFLOW_REF: ref });
    expect(scheduleAuthorized(env('schedule', `${REPO}/.github/workflows/stable-daily.yml@refs/heads/master`), REPO)).toBe(true);
    expect(scheduleAuthorized(env('workflow_dispatch', `${REPO}/.github/workflows/stable-daily.yml@refs/heads/master`), REPO)).toBe(false);
    expect(scheduleAuthorized(env('schedule', `${REPO}/.github/workflows/promote-stable.yml@refs/heads/master`), REPO)).toBe(false);
    expect(scheduleAuthorized(env('schedule', `acme-example/gbrain/.github/workflows/stable-daily.yml@refs/heads/master`), REPO)).toBe(false);
    expect(scheduleAuthorized(env('schedule', `${REPO}/.github/workflows/stable-daily.yml@refs/tags/v1`), REPO)).toBe(false);
    expect(scheduleAuthorized({}, REPO)).toBe(false);
  });

  test('a scheduled promotion skips the role read and records the schedule as the promoter; a dispatch keeps the maintainer check', async () => {
    const w = world(base({ runs: [soak(9, 2)] }));
    const p = await promote(w.deps, { version: '1.0.2', soakRunUrl: `https://github.com/${REPO}/actions/runs/9`, scoreboardUrl: '', rollback: false, reason: '' });
    expect(w.api.some(a => a.endsWith('/permission'))).toBe(false);
    expect(p.promotedBy).toBe('schedule (.github/workflows/stable-daily.yml)');
    const d = world(base({ runs: [soak(9, 2)], scheduled: false }));
    const error = await promote(d.deps, { version: '1.0.2', soakRunUrl: `https://github.com/${REPO}/actions/runs/9`, scoreboardUrl: '', rollback: false, reason: '' }).then(() => null, e => e);
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Error).message).toMatch(/has the none role/);
  });
});

describe('integrity gates', () => {
  test('every integrity gate must pass in every cell; latency gates stay record-only; no data or no cells fails closed', () => {
    expect(integrityFailures(CLEAN)).toEqual([]);
    expect(integrityFailures([])).toEqual(['no scoreboard artifact']);
    const leak = structuredClone(CLEAN);
    leak[1]!.gates!.find(g => g.id === 'privacy_leaks')!.pass = false;
    leak[0]!.gates!.find(g => g.id === 'read_errors')!.pass = null;
    expect(integrityFailures(leak)).toEqual(['rtt2: read_errors has no data', 'rtt65: privacy_leaks failed']);
    expect(integrityFailures([{ label: 'rtt2', gates: [] }])).toHaveLength(5);
  });

  test('parseRecord reads the key: value body of a stable tag', () => {
    expect(parseRecord(stableMessage('1.0.1', '2026-11-08T05:17:00Z', true))).toMatchObject({ version: '1.0.1', rollback: 'true', reason: 'sync regression' });
  });
});

describe('daily: when it does nothing', () => {
  test('the kill switch turns it off before anything is read', async () => {
    const w = world(base({ autoPromote: 'off' }));
    expect((await daily(w.deps)).action).toBe('off');
    expect(w.api).toEqual([]);
  });

  test('a rollback pauses it until a maintainer promotes by hand', async () => {
    const w = world(base({ stable: { version: '1.0.1', commit: 1, message: stableMessage('1.0.1', '2026-11-01T00:00:00Z', true) }, runs: [soak(9, 4)] }));
    const r = await daily(w.deps);
    expect(r.action).toBe('paused');
    expect(w.pushes).toEqual([]);
    expect(w.posts).toEqual([]);
  });

  test('no important fix and stable under 7 days old: nothing happens', async () => {
    const w = world(base({ runs: [soak(9, 4)] }));
    const r = await daily(w.deps);
    expect(r.action).toBe('none');
    expect(w.pushes).toEqual([]);
    expect(w.posts).toEqual([]);
  });

  test('an important fix already in stable, or not released yet, is no reason', async () => {
    const inStable = world(base({ importantPrs: [{ number: 11, merge: 1 }], runs: [soak(9, 4)] }));
    expect((await daily(inStable.deps)).action).toBe('none');
    const unreleased = world(base({ importantPrs: [{ number: 12, merge: 6 }], runs: [soak(9, 4)] }));
    expect((await daily(unreleased.deps)).action).toBe('none');
  });
});

describe('daily: important fixes', () => {
  test('promotes the newest soaked release that carries the fix', async () => {
    const w = world(base({ importantPrs: [{ number: 30, merge: 3 }], runs: [soak(8, 2), soak(9, 3)] }));
    const r = await daily(w.deps);
    expect(r.action).toBe('promoted');
    if (r.action !== 'promoted') return;
    expect(r.promotion.version).toBe('1.0.3');
    expect(r.promotion.soakRun).toBe(`https://github.com/${REPO}/actions/runs/9`);
    expect(r.promotion.reason).toContain('important: #30 (v1.0.3)');
    expect(w.pushes).toHaveLength(1);
  });

  test('a scheduled promotion writes stable.json in the same atomic push as the tags, so stable clients read it', async () => {
    const w = world(base({ importantPrs: [{ number: 30, merge: 3 }], runs: [soak(9, 3)] }));
    const r = await daily(w.deps);
    expect(r.action).toBe('promoted');
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]).toMatch(/^--atomic .*--force-with-lease=refs\/heads\/stable-record:rec-published origin .*refs\/tags\/stable:refs\/tags\/stable rec-\d+:refs\/heads\/stable-record$/);
    expect(parseStableRecord(w.record()!)).toMatchObject({ ok: true, record: { version: '1.0.3', commit: sha(3), tree: tree(3), soak_run: `https://github.com/${REPO}/actions/runs/9`, previous: '1.0.1', rollback: false, known_bad: [] } });
    expect(JSON.parse(w.record()!)).toMatchObject({ promoted_by: 'schedule (.github/workflows/stable-daily.yml)' });
  });

  test('a soaked release without the fix is not promoted on the important path; the newest release gets one soak instead', async () => {
    const w = world(base({ importantPrs: [{ number: 30, merge: 3 }], runs: [soak(8, 2)] }));
    const r = await daily(w.deps);
    expect(r).toMatchObject({ action: 'soak_dispatched', version: '1.0.4' });
    expect(w.posts).toEqual([{ path: `repos/${REPO}/actions/workflows/production-soak.yml/dispatches`, body: { ref: 'v1.0.4' } }]);
    expect(w.pushes).toEqual([]);
  });

  test('a soak whose integrity gates failed is skipped for an older clean one that still carries the fix', async () => {
    const leak = structuredClone(CLEAN);
    leak[0]!.gates!.find(g => g.id === 'privacy_leaks')!.pass = false;
    const w = world(base({ importantPrs: [{ number: 30, merge: 3 }], runs: [soak(9, 3), soak(10, 4, { boards: leak })] }));
    const r = await daily(w.deps);
    expect(r.action === 'promoted' && r.promotion.version).toBe('1.0.3');
    expect(w.logs.some(l => l.includes('rtt2: privacy_leaks failed'))).toBe(true);
  });

  test('a soak already running means wait; a finished soak on the newest release that did not qualify is never re-dispatched', async () => {
    const running = world(base({ importantPrs: [{ number: 40, merge: 4 }], runs: [soak(9, 4, { status: 'in_progress', conclusion: null })] }));
    expect((await daily(running.deps)).action).toBe('waiting');
    expect(running.posts).toEqual([]);
    const failed = world(base({ importantPrs: [{ number: 40, merge: 4 }], runs: [soak(9, 4, { conclusion: 'failure' })] }));
    const r = await daily(failed.deps);
    expect(r.action).toBe('waiting');
    expect(r.why).toContain('a maintainer decides');
    expect(failed.posts).toEqual([]);
    expect(failed.pushes).toEqual([]);
  });
});

describe('daily: weekly floor', () => {
  const old = { version: '1.0.1', commit: 1, message: stableMessage('1.0.1', '2026-11-02T05:17:00Z') };

  test('stable older than 7 days promotes the newest soaked release', async () => {
    const w = world(base({ stable: old, runs: [soak(8, 2), soak(9, 3)] }));
    const r = await daily(w.deps);
    expect(r.action === 'promoted' && r.promotion.version).toBe('1.0.3');
    expect(r.why).toContain('weekly floor');
  });

  test('a dry run reports and writes nothing', async () => {
    const w = world(base({ stable: old, runs: [soak(9, 3)], dryRun: true }));
    expect(await daily(w.deps)).toMatchObject({ action: 'dry_run', would: expect.stringContaining('promote v1.0.3') });
    const none = world(base({ stable: old, dryRun: true }));
    expect(await daily(none.deps)).toMatchObject({ action: 'dry_run', would: 'dispatch the soak on v1.0.4' });
    expect([...w.pushes, ...none.pushes]).toEqual([]);
    expect([...w.posts, ...none.posts]).toEqual([]);
  });

  test('never moves stable backward: only releases newer than stable are candidates', async () => {
    const w = world(base({ stable: { ...old, version: '1.0.4', commit: 4, message: stableMessage('1.0.4', '2026-11-02T05:17:00Z') }, runs: [soak(9, 3)] }));
    expect((await daily(w.deps)).action).toBe('none');
  });
});

describe('daily: stable.json backfill (GBRA-346)', () => {
  const SOAK_7 = `https://github.com/${REPO}/actions/runs/7`;
  const tagged = (version: string, commit: number, rollback = false) => renderTagMessage({
    version, commit: sha(commit), tree: tree(commit), soakRun: SOAK_7, scoreboard: SOAK_7, promotedBy: 'alice-example',
    promotedAt: '2026-11-08T05:17:00Z', previous: null, rollback, reason: rollback ? 'sync regression' : '',
  });
  const unrecorded = (over: Partial<World> = {}) => base({ stable: { version: '1.0.1', commit: 1, message: tagged('1.0.1', 1) }, runs: [soak(7, 1)], published: null, ...over });

  test('a scheduled run writes the missing record for the current stable from its tag message, moving no tag, and stops', async () => {
    const w = world(unrecorded({ importantPrs: [{ number: 30, merge: 3 }], runs: [soak(7, 1), soak(9, 3)] }));
    const r = await daily(w.deps);
    expect(r).toMatchObject({ action: 'backfilled', why: 'stable.json is not published, not stable v1.0.1' });
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]).toBe('--atomic --force-with-lease=refs/tags/stable:tagobj-stable --force-with-lease=refs/heads/stable-record: origin refs/tags/stable:refs/tags/stable ' + w.pushes[0]!.split(' ').at(-1));
    expect(w.pushes[0]!.split(' ').at(-1)).toMatch(/^rec-.*:refs.heads.stable-record$/);
    expect(parseStableRecord(w.record()!)).toMatchObject({ ok: true, record: { version: '1.0.1', commit: sha(1), tree: tree(1), soak_run: SOAK_7, previous: null, known_bad: [] } });
    expect(w.tags.stable!.message).toBe(tagged('1.0.1', 1));
    expect(w.api.some(a => a.startsWith('search/issues'))).toBe(false);

    const stale = world(unrecorded({ published: JSON.stringify({ schema: 1, version: '1.0.0', commit: sha(0), known_bad: ['0.9.0'] }) }));
    expect((await daily(stale.deps)).why).toBe('stable.json names v1.0.0, not stable v1.0.1');
    expect(JSON.parse(stale.record()!)).toMatchObject({ version: '1.0.1', commit: sha(1), known_bad: ['0.9.0'] });
    expect(stale.pushes[0]).toContain('--force-with-lease=refs/heads/stable-record:rec-published');
  });

  test('a dry run reports the backfill and writes nothing', async () => {
    const w = world(unrecorded({ dryRun: true }));
    expect(await daily(w.deps)).toMatchObject({ action: 'dry_run', would: 'backfill the record for v1.0.1' });
    expect(w.pushes).toEqual([]);
    expect(w.posts).toEqual([]);
  });

  test('a record that already names stable is a no-op, and the run goes on to the reason check', async () => {
    const quiet = world(base({ runs: [soak(9, 4)] }));
    expect((await daily(quiet.deps)).action).toBe('none');
    expect(quiet.api.some(a => a.startsWith('search/issues'))).toBe(true);
    expect(quiet.pushes).toEqual([]);
    const important = world(base({ importantPrs: [{ number: 30, merge: 3 }], runs: [soak(9, 3)] }));
    expect((await daily(important.deps)).action).toBe('promoted');
  });

  test('the kill switch and a rollback pause both win over the backfill; a tag message with no soak run refuses', async () => {
    const off = world(unrecorded({ autoPromote: 'off' }));
    expect((await daily(off.deps)).action).toBe('off');
    const paused = world(unrecorded({ stable: { version: '1.0.1', commit: 1, message: tagged('1.0.1', 1, true) } }));
    expect((await daily(paused.deps)).action).toBe('paused');
    expect([...off.pushes, ...paused.pushes]).toEqual([]);
    const bare = world(unrecorded({ stable: { version: '1.0.1', commit: 1, message: stableMessage('1.0.1', '2026-11-08T05:17:00Z') } }));
    const error = await daily(bare.deps).then(() => null, e => e);
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Error).message).toContain('names no soak_run, so its stable.json cannot be written from it');
    expect(bare.pushes).toEqual([]);
  });

  test('a maintainer dispatch with dry_run=false backfills; anyone else is refused by the role check', async () => {
    const maintainer = world(unrecorded({ scheduled: false }));
    const ghApi = maintainer.deps.ghApi;
    maintainer.deps.ghApi = async path => (path.endsWith('/permission') ? { permission: 'write', role_name: 'maintain' } : ghApi(path));
    expect((await daily(maintainer.deps)).action).toBe('backfilled');
    const other = world(unrecorded({ scheduled: false }));
    await expect(daily(other.deps)).rejects.toThrow(/has the none role/);
    expect(other.pushes).toEqual([]);
  });
});

describe('stable-daily.yml', () => {
  const wf = load(readFileSync(join(ROOT, '.github/workflows/stable-daily.yml'), 'utf8')) as {
    on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs: Record<string, { default: unknown; type: string }> } };
    permissions: Record<string, string>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: { daily: { steps: Array<{ run?: string; env?: Record<string, string> }> } };
  };

  test('runs twice a day plus a dry-run-by-default dispatch, sharing the promote-stable concurrency group', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.on.schedule.map(s => s.cron)).toEqual(['17 5 * * *', '17 13 * * *']);
    expect(wf.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
    expect(wf.permissions).toEqual({ contents: 'write', actions: 'write' });
    expect(wf.concurrency).toEqual({ group: 'promote-stable', 'cancel-in-progress': false });
  });

  test('inputs reach the script through env only, and no dependency install runs', () => {
    const step = wf.jobs.daily.steps.find(s => s.run?.includes('scripts/stable-daily.ts'))!;
    expect(step.run).not.toContain('${{');
    expect(step.env).toMatchObject({ STABLE_AUTO_PROMOTE: '${{ vars.STABLE_AUTO_PROMOTE }}', STABLE_SOAK_WORKFLOW: '${{ vars.STABLE_SOAK_WORKFLOW }}' });
    expect(wf.jobs.daily.steps.some(s => /bun install|npm (ci|install)/.test(s.run ?? ''))).toBe(false);
  });
});

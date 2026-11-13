#!/usr/bin/env bun
/**
 * Upgrade matrix (GBRA-224 W2): install published old releases, upgrade each
 * through its own updater to one candidate, and check the candidate on the
 * upgraded brain. Workflow: .github/workflows/upgrade-matrix.yml. Docs:
 * docs/ci-upgrade-matrix.md.
 *
 *   bun scripts/upgrade-matrix.ts plan --candidate <vX.Y.Z.W | sha | ''> [--profile full|pr] [--from v1,v2] --out plan.json
 *   bun scripts/upgrade-matrix.ts cell --plan plan.json --from <tag> --engine pglite|postgres --keys keyless|keyed
 *        [--brain repo-less|repo|both] [--postgres-url <superuser url>] [--fault corrupt-after-upgrade] --out-dir <dir>
 *   bun scripts/upgrade-matrix.ts summarize --plan plan.json --receipts <dir> --out summary.json
 *   bun scripts/upgrade-matrix.ts issue --summary summary.json [--dry-run]
 *
 * The plan resolves the candidate (tag, commit, tree) and the from-versions
 * once and records them with the harness commit; cells and the summary read
 * only the plan, so every job of a run agrees on what it tested.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fetchReleases, hasEnoughHistory, RELEASE_TAG, resolveFromVersions, type Candidate, type FromVersion, type Profile, type Release } from './upgrade-matrix/versions.ts';
import { cellId, runCell, type BrainShape, type Engine, type Fault, type Keys } from './upgrade-matrix/cell.ts';
import { CHECKS, loadKnownExceptions, summarize, type CellSummary } from './upgrade-matrix/verdict.ts';

const REPO = 'garrytan/gbrain';
const ROOT = resolve(import.meta.dir, '..');
const BT = '\x60';
export const ISSUE_MARKER = '<!-- gbrain-upgrade-matrix:nightly -->';
export const ISSUE_LABEL = 'upgrade-break';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : fallback; };
const git = (...args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function ensureCommit(ref: string): string {
  const has = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', ref + '^{commit}'], { encoding: 'utf8' });
  if (has.status === 0) return has.stdout.trim();
  const fetch = RELEASE_TAG.test(ref) || ref === 'stable'
    ? ['fetch', '--quiet', '--no-tags', 'origin', '+refs/tags/' + ref + ':refs/tags/' + ref]
    : ['fetch', '--quiet', '--no-tags', 'origin', ref];
  execFileSync('git', ['-C', ROOT, ...fetch], { stdio: ['ignore', 'pipe', 'pipe'] });
  return git('rev-parse', ref + '^{commit}');
}

const commitVersion = (sha: string) => git('show', sha + ':VERSION').split('\n')[0]!.trim();
const commitTime = (sha: string) => new Date(Number(git('log', '-1', '--format=%ct', sha)) * 1000).toISOString();

export interface Plan {
  schema: 'gbrain-upgrade-matrix-plan/1';
  harness: { sha: string; dirty: boolean; workflow_ref: string | null; workflow_sha: string | null; event: string | null; run_url: string | null };
  candidate: Candidate;
  profile: Profile | 'explicit';
  from: Array<FromVersion & { sha: string }>;
  skipped: Array<{ role: string; reason: string }>;
  jobs: Array<{ from: string; engine: Engine; keys: Keys; brain: BrainShape | 'both' }>;
  cells: string[];
}

async function plan(): Promise<void> {
  const profile = flag('--profile', 'full') as Profile;
  if (profile !== 'full' && profile !== 'pr') throw new Error('--profile takes full or pr');
  const input = (flag('--candidate', '') ?? '').trim();
  const releases = await fetchReleases(REPO, rs => {
    const newest = rs[0];
    return !!newest && hasEnoughHistory(rs, candidateHint(rs, input) ?? newest);
  });
  if (!releases.length) throw new Error('no published releases found');
  let candidate: Candidate;
  if (!input || RELEASE_TAG.test(input)) {
    const rel = input ? releases.find(r => r.tag === input) : [...releases].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    if (!rel) throw new Error('candidate ' + input + ' is not a published release');
    const sha = ensureCommit(rel.tag);
    candidate = { tag: rel.tag, sha, tree: git('rev-parse', sha + '^{tree}'), version: rel.version, published_at: rel.published_at };
  } else {
    const sha = ensureCommit(input);
    candidate = { tag: null, sha, tree: git('rev-parse', sha + '^{tree}'), version: commitVersion(sha), published_at: commitTime(sha) };
  }
  const explicit = flag('--from');
  let from: FromVersion[];
  let skipped: Plan['skipped'] = [];
  if (explicit) {
    from = explicit.split(',').map(t => t.trim()).filter(Boolean).map(tag => {
      const m = RELEASE_TAG.exec(tag);
      if (!m) throw new Error('--from takes release tags: ' + tag);
      return { tag, version: m[1]!, published_at: releases.find(r => r.tag === tag)?.published_at ?? '', roles: ['explicit' as never] };
    });
  } else {
    const resolved = resolveFromVersions(releases, candidate, { profile, stableVersion: stableVersion() });
    from = resolved.from;
    skipped = resolved.skipped;
  }
  const withSha = from.map(f => ({ ...f, sha: ensureCommit(f.tag) }));
  const reduced = profile === 'pr' && !explicit;
  const keys: Keys[] = reduced ? ['keyless'] : ['keyless', 'keyed'];
  const brain: BrainShape | 'both' = reduced ? 'repo-less' : 'both';
  const jobs = withSha.flatMap(f => (['pglite', 'postgres'] as Engine[]).flatMap(engine => keys.map(k => ({ from: f.tag, engine, keys: k, brain }))));
  const cells = jobs.flatMap(j => (j.brain === 'both' ? ['repo-less', 'repo'] : [j.brain]).map(b => cellId({ from: { tag: j.from }, engine: j.engine, keys: j.keys, brain: b })));
  const out: Plan = {
    schema: 'gbrain-upgrade-matrix-plan/1',
    harness: {
      sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
      workflow_ref: process.env.GITHUB_WORKFLOW_REF ?? null, workflow_sha: process.env.GITHUB_WORKFLOW_SHA ?? null, event: process.env.GITHUB_EVENT_NAME ?? null,
      run_url: process.env.GITHUB_RUN_ID ? (process.env.GITHUB_SERVER_URL ?? 'https://github.com') + '/' + (process.env.GITHUB_REPOSITORY ?? REPO) + '/actions/runs/' + process.env.GITHUB_RUN_ID : null,
    },
    candidate, profile: explicit ? 'explicit' : profile, from: withSha, skipped, jobs, cells,
  };
  writeFileSync(flag('--out', 'upgrade-matrix-plan.json')!, JSON.stringify(out, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'matrix=' + JSON.stringify({ include: jobs }) + '\ncandidate_sha=' + candidate.sha + '\n');
  console.log('candidate ' + (candidate.tag ?? '(commit)') + ' ' + candidate.sha.slice(0, 12) + ' v' + candidate.version + '; from ' + withSha.map(f => f.tag + ' [' + f.roles.join(',') + ']').join(', ')
    + (skipped.length ? '; skipped ' + skipped.map(s => s.role + ': ' + s.reason).join('; ') : '') + '; ' + cells.length + ' cells in ' + jobs.length + ' jobs');
}

/** The stable tag's release version, or null when the tag does not exist or cannot be read. */
function stableVersion(): string | null {
  const ls = spawnSync('git', ['-C', ROOT, 'ls-remote', '--tags', 'origin', 'refs/tags/stable'], { encoding: 'utf8' });
  if (ls.status !== 0 || !ls.stdout.trim()) return null;
  try { return commitVersion(ensureCommit('stable')); } catch { return null; }
}

function candidateHint(releases: Release[], input: string): { version: string; published_at: string } | null {
  if (!input) return null;
  const rel = releases.find(r => r.tag === input);
  if (rel) return rel;
  try { const sha = ensureCommit(input); return { version: commitVersion(sha), published_at: commitTime(sha) }; } catch { return null; }
}

async function cell(): Promise<void> {
  const p = JSON.parse(readFileSync(flag('--plan', 'upgrade-matrix-plan.json')!, 'utf8')) as Plan;
  const tag = flag('--from');
  const from = p.from.find(f => f.tag === tag);
  if (!from) throw new Error('--from ' + tag + ' is not in the plan (' + p.from.map(f => f.tag).join(', ') + ')');
  const engine = flag('--engine') as Engine, keys = flag('--keys') as Keys, brainFlag = flag('--brain', 'both')!;
  if (!['pglite', 'postgres'].includes(engine) || !['keyless', 'keyed'].includes(keys)) throw new Error('--engine pglite|postgres and --keys keyless|keyed are required');
  const brains: BrainShape[] = brainFlag === 'both' ? ['repo-less', 'repo'] : [brainFlag as BrainShape];
  const outDir = resolve(flag('--out-dir', 'upgrade-matrix-out')!);
  mkdirSync(outDir, { recursive: true });
  ensureCommit(from.sha);
  ensureCommit(p.candidate.sha);
  const exceptions = loadKnownExceptions();
  let red = false;
  for (const brain of brains) {
    const receipt = await runCell({
      from: { tag: from.tag, version: from.version, sha: from.sha, roles: from.roles }, candidate: p.candidate, engine, keys, brain,
      harnessRoot: ROOT, harnessSha: git('rev-parse', 'HEAD'), workDir: join(outDir, 'cells'), cacheDir: resolve(flag('--cache-dir', join(outDir, 'cache'))!),
      postgresUrl: flag('--postgres-url') ?? process.env.UPGRADE_MATRIX_POSTGRES_URL, fault: (flag('--fault') as Fault | undefined) ?? null, exceptions,
    });
    writeFileSync(join(outDir, 'receipt-' + receipt.id + '.json'), JSON.stringify(receipt, null, 2) + '\n');
    const failures = receipt.failures as Array<{ check: string; detail: string }>;
    console.log(String(receipt.verdict).toUpperCase() + ' ' + receipt.id + ' (' + receipt.elapsed_s + ' s)' + failures.map(f => '\n  - ' + f.check + ': ' + f.detail.split('\n')[0]).join(''));
    if (receipt.verdict !== 'pass' && receipt.verdict !== 'known_exception') red = true;
  }
  if (red) process.exitCode = 1;
}

function loadReceipts(dir: string): any[] {
  const out: any[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^(receipt|door)-.*\.json$/.test(e.name)) out.push(JSON.parse(readFileSync(p, 'utf8')));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export function buildSummary(p: Plan, receipts: any[]): any {
  const doors = receipts.filter(r => r.schema === 'gbrain-upgrade-matrix-door/1');
  const cellReceipts = receipts.filter(r => r.schema === 'gbrain-upgrade-matrix-cell/1');
  const foreign = [...cellReceipts, ...doors].filter(r => r.candidate?.sha !== p.candidate.sha || r.harness_sha !== p.harness.sha);
  const cells: CellSummary[] = cellReceipts.filter(r => !foreign.includes(r)).map(r => ({
    id: r.id, from: r.from.tag, roles: r.from.roles, shape: [r.shape.engine, r.shape.keys, r.shape.brain].join(' '), verdict: r.verdict,
    open: r.failures ?? [], excepted: (r.known_exceptions ?? []).map((e: any) => ({ check: e.check, issue: e.issue })), fault: r.fault,
  }));
  const s = summarize(p.cells, cells);
  const doorRed = doors.filter(d => !foreign.includes(d) && d.verdict === 'fail');
  const doorHold = doors.filter(d => !foreign.includes(d) && d.verdict === 'hold');
  return {
    schema: 'gbrain-upgrade-matrix-run/1', harness: p.harness, candidate: p.candidate, profile: p.profile, from: p.from, skipped: p.skipped,
    status: s.red.length || foreign.length || doorRed.length ? 'red' : s.holds.length || doorHold.length ? 'hold' : 'green',
    cells, red: [...s.red.map(c => c.id), ...doorRed.map(d => 'door:' + d.door)], holds: [...s.holds.map(c => c.id), ...doorHold.map(d => 'door:' + d.door)], foreign_receipts: foreign.map(r => r.id ?? r.door),
    doors: doors.map(d => ({ door: d.door, verdict: d.verdict, reason: d.reason ?? null })),
  };
}

function summarizeRun(): void {
  const p = JSON.parse(readFileSync(flag('--plan', 'upgrade-matrix-plan.json')!, 'utf8')) as Plan;
  const summary = buildSummary(p, loadReceipts(flag('--receipts', 'receipts')!));
  writeFileSync(flag('--out', 'upgrade-matrix-summary.json')!, JSON.stringify(summary, null, 2) + '\n');
  const md = renderSummary(summary);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  if (summary.status === 'red') process.exitCode = 1;
}

export function renderSummary(s: any): string {
  const cellRow = (c: any) => '| ' + c.from + ' ' + c.shape + ' | ' + c.verdict + (c.fault ? ' (fault ' + c.fault + ')' : '') + ' | '
    + [...c.open.map((f: any) => f.check + ': ' + String(f.detail).split('\n')[0]!.replace(/\|/g, '/').slice(0, 160)), ...c.excepted.map((e: any) => e.check + ' (known: ' + e.issue + ')')].join('<br>') + ' |';
  const lines = [
    '## Upgrade matrix: ' + String(s.status).toUpperCase(),
    '',
    'Candidate ' + (s.candidate.tag ?? '(unreleased commit)') + ' ' + BT + s.candidate.sha + BT + ' (v' + s.candidate.version + ', tree ' + BT + s.candidate.tree.slice(0, 12) + BT + '); harness ' + BT + s.harness.sha.slice(0, 12) + BT + ' (' + (s.harness.workflow_ref ?? 'local') + ').',
    'From: ' + s.from.map((f: any) => f.tag + ' (' + f.roles.join(', ') + ')').join(', ') + (s.skipped.length ? '. Skipped: ' + s.skipped.map((k: any) => k.role + ' (' + k.reason + ')').join('; ') : '') + '.',
    '',
    '| Cell | Verdict | Failures |',
    '| --- | --- | --- |',
    ...s.cells.map(cellRow),
  ];
  const missing = s.red.filter((id: string) => !id.startsWith('door:') && !s.cells.some((c: any) => c.id === id));
  if (missing.length) lines.push('', 'No receipt: ' + missing.join(', '));
  if (s.foreign_receipts.length) lines.push('', 'Receipts from another candidate or harness (ignored; the run is red): ' + s.foreign_receipts.join(', '));
  for (const d of s.doors ?? []) lines.push('', 'Door ' + d.door + ': ' + String(d.verdict).toUpperCase() + (d.reason ? ' (' + d.reason + ')' : ''));
  lines.push('', 'Checks: ' + Object.keys(CHECKS).map(k => BT + k + BT).join(', ') + '. Docs: docs/ci-upgrade-matrix.md');
  return lines.join('\n');
}

async function issue(): Promise<void> {
  const s = JSON.parse(readFileSync(flag('--summary', 'upgrade-matrix-summary.json')!, 'utf8'));
  const dry = argv.includes('--dry-run');
  const auth = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch('https://api.github.com/repos/' + (process.env.GITHUB_REPOSITORY ?? REPO) + path, {
      method, headers: { accept: 'application/vnd.github+json', 'user-agent': 'gbrain-upgrade-matrix', ...(auth ? { authorization: 'Bearer ' + auth } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(method + ' ' + path + ' returned HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    return res.status === 204 ? null : res.json();
  };
  const existing = (await api('GET', '/issues?state=all&labels=' + ISSUE_LABEL + '&per_page=100') as any[]).find(i => !i.pull_request && String(i.body ?? '').includes(ISSUE_MARKER));
  const body = ISSUE_MARKER + '\n' + renderSummary(s) + '\n\nRun: ' + (s.harness.run_url ?? '(local)') + '\n\nThis issue carries the ' + BT + ISSUE_LABEL + BT + ' label, which holds stable promotion while it is open. The nightly matrix closes it when a later run is green.';
  if (s.status === 'red') {
    const title = 'Upgrade matrix red: upgrading to ' + (s.candidate.tag ?? s.candidate.sha.slice(0, 12)) + ' fails ' + s.red.length + ' cell(s)';
    if (dry) { console.log((existing ? 'update #' + existing.number : 'create') + ': ' + title + '\n' + body); return; }
    if (existing) {
      await api('PATCH', '/issues/' + existing.number, { title, body, state: 'open' });
      await api('POST', '/issues/' + existing.number + '/comments', { body: 'Still red on ' + (s.candidate.tag ?? s.candidate.sha) + ': ' + s.red.join(', ') + '. ' + (s.harness.run_url ?? '') });
      console.log('updated #' + existing.number);
    } else {
      const created = await api('POST', '/issues', { title, body, labels: [ISSUE_LABEL] }) as any;
      console.log('created #' + created.number);
    }
  } else if (s.status === 'green' && existing?.state === 'open') {
    if (dry) { console.log('close #' + existing.number); return; }
    await api('POST', '/issues/' + existing.number + '/comments', { body: 'Green on ' + (s.candidate.tag ?? s.candidate.sha) + ': every planned cell passed. ' + (s.harness.run_url ?? '') });
    await api('PATCH', '/issues/' + existing.number, { state: 'closed', state_reason: 'completed' });
    console.log('closed #' + existing.number);
  } else console.log('no issue change (status ' + s.status + (existing ? ', issue #' + existing.number + ' ' + existing.state : '') + ')');
}

if (import.meta.main) {
  const cmd = argv[0];
  const run = cmd === 'plan' ? plan : cmd === 'cell' ? cell : cmd === 'summarize' ? async () => summarizeRun() : cmd === 'issue' ? issue : null;
  if (!run) { console.error('usage: bun scripts/upgrade-matrix.ts plan|cell|summarize|issue (see the header)'); process.exit(2); }
  await run();
}

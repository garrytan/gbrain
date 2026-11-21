/**
 * Dry-run pins for .github/workflows/vorflux-notify.yml (GST-3394).
 *
 * The workflow wakes the Rust engine agent at once only for Capy and
 * maintainer comments, a merge or close and a red full check on its own pull
 * requests, and sends everything else in a 30-minute digest. These tests
 * evaluate each job-level if against sample event payloads (which events
 * start a runner at all), and run each job's script with fake gh and curl
 * commands that serve canned REST responses and capture the POST, so the
 * bodies, delivery ids and the never-send-comment-text rule are checked
 * without GitHub or the hook.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = join(import.meta.dir, '..');
const SOURCE = readFileSync(join(ROOT, '.github/workflows/vorflux-notify.yml'), 'utf8');
const WORKFLOW = load(SOURCE) as any;
const NOTIFY = WORKFLOW.jobs.notify;
const DIGEST = WORKFLOW.jobs.digest;
const SCRIPTS = [NOTIFY.steps[0].run as string, DIGEST.steps[0].run as string];

type Tok = { t: 'str' | 'num' | 'op' | 'id'; v: any };

function tokenize(src: string): Tok[] {
  const re = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|(==|!=|<=|>=|&&|\|\||[()[\].,!<>*])|([A-Za-z_][A-Za-z0-9_-]*))/y;
  const out: Tok[] = [];
  while (re.lastIndex < src.length && src.slice(re.lastIndex).trim() !== '') {
    const m = re.exec(src);
    if (!m) throw new Error('unparsed expression at: ' + src.slice(re.lastIndex));
    if (m[1] !== undefined) out.push({ t: 'str', v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2] !== undefined) out.push({ t: 'num', v: Number(m[2]) });
    else if (m[3] !== undefined) out.push({ t: 'op', v: m[3] });
    else out.push({ t: 'id', v: m[4] });
  }
  return out;
}

class Filtered extends Array<unknown> {}

/** The subset of GitHub Actions expressions the workflow uses, with GitHub's loose equality and truthiness. */
function evaluate(src: string, ctx: Record<string, unknown>): unknown {
  const toks = tokenize(src);
  let i = 0;
  const at = (v: string) => toks[i]?.t === 'op' && toks[i].v === v;
  const eat = (v: string) => {
    if (!at(v)) throw new Error('expected ' + v + ' at token ' + i);
    i++;
  };
  const truthy = (v: unknown) => !(v === false || v === 0 || v === '' || v == null || Number.isNaN(v));
  const num = (v: unknown) =>
    v == null ? 0 : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? (v.trim() === '' ? 0 : Number(v)) : typeof v === 'number' ? v : NaN;
  const eq = (a: unknown, b: unknown) => {
    a = a ?? null;
    b = b ?? null;
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
    if (typeof a === typeof b) return a === b;
    return num(a) === num(b);
  };
  const prop = (v: unknown, name: string): unknown => {
    if (v instanceof Filtered) return Filtered.from(v.map((x) => prop(x, name)).filter((x) => x !== null));
    return v != null && typeof v === 'object' ? ((v as any)[name] ?? null) : null;
  };
  const call = (name: string, args: unknown[]) => {
    const [a, b] = args;
    if (name !== 'contains') throw new Error('unsupported function ' + name);
    return Array.isArray(a) ? a.some((x) => eq(x, b)) : String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
  };
  const primary = (): unknown => {
    const tok = toks[i++];
    if (!tok) throw new Error('unexpected end of expression');
    if (tok.t === 'op' && tok.v === '(') {
      const v = or();
      eat(')');
      return v;
    }
    if (tok.t === 'str' || tok.t === 'num') return tok.v;
    if (tok.t !== 'id') throw new Error('unexpected token ' + tok.v);
    if (tok.v === 'true') return true;
    if (tok.v === 'false') return false;
    if (tok.v === 'null') return null;
    if (at('(')) {
      i++;
      const args: unknown[] = [];
      while (!at(')')) {
        args.push(or());
        if (at(',')) i++;
      }
      eat(')');
      return call(tok.v, args);
    }
    return ctx[tok.v] ?? null;
  };
  const postfix = (): unknown => {
    let v = primary();
    for (;;) {
      if (at('.')) {
        i++;
        const tok = toks[i++];
        v = tok.t === 'op' && tok.v === '*' ? Filtered.from(Array.isArray(v) ? v : Object.values(v ?? {})) : prop(v, tok.v);
      } else if (at('[')) {
        i++;
        const key = or();
        eat(']');
        v = prop(v, String(key));
      } else return v;
    }
  };
  const unary = (): unknown => {
    if (!at('!')) return postfix();
    i++;
    return !truthy(unary());
  };
  const equality = (): unknown => {
    let l = unary();
    while (at('==') || at('!=')) {
      const op = toks[i++].v;
      const r = unary();
      l = op === '==' ? eq(l, r) : !eq(l, r);
    }
    return l;
  };
  const and = (): unknown => {
    let l = equality();
    while (at('&&')) {
      i++;
      const r = equality();
      l = truthy(l) ? r : l;
    }
    return l;
  };
  const or = (): unknown => {
    let l = and();
    while (at('||')) {
      i++;
      const r = and();
      l = truthy(l) ? l : r;
    }
    return l;
  };
  const v = or();
  if (i !== toks.length) throw new Error('trailing tokens from ' + i);
  return v;
}

const runs = (job: any, event_name: string, event: unknown) =>
  Boolean(evaluate(job.if, { github: { event_name, event, repository: 'garrytan/gbrain' } }));

const labels = (...names: string[]) => names.map((name) => ({ name }));
const ember = { number: 7, labels: labels('rust-engine'), head: { repo: { full_name: 'garrytan/gbrain' }, sha: 'a'.repeat(40) } };
const other = { ...ember, labels: labels('bug') };
const fork = { ...ember, head: { repo: { full_name: 'someone/gbrain' }, sha: 'a'.repeat(40) } };
const issueOn = (pr: { labels: unknown }) => ({ number: 7, labels: pr.labels, pull_request: { url: 'x' } });
const comment = (login: string, body = 'please change this') => ({ id: 555, user: { login }, body });
const run = (over: Record<string, unknown>) => ({
  name: 'Test',
  event: 'workflow_dispatch',
  conclusion: 'failure',
  head_repository: { full_name: 'garrytan/gbrain' },
  head_sha: 'a'.repeat(40),
  head_branch: 'vorflux/x',
  ...over,
});

describe('vorflux-notify.yml triggers and safety', () => {
  test('pushes and label changes no longer start a run; the digest runs at :05 and :35', () => {
    const on = WORKFLOW.on;
    expect(on.pull_request_target.types).toEqual(['closed']);
    expect(on.workflow_run.workflows).toEqual(['Test', 'E2E Tests', 'macOS 26 validation']);
    expect(on.workflow_run['branches-ignore']).toEqual(['master', 'gh-readonly-queue/**']);
    expect(on.schedule).toEqual([{ cron: '5,35 * * * *' }]);
    expect(Object.keys(on).sort()).toEqual(
      ['issue_comment', 'pull_request_review', 'pull_request_review_comment', 'pull_request_target', 'schedule', 'workflow_dispatch', 'workflow_run'].sort(),
    );
    expect(WORKFLOW.permissions).toEqual({});
  });

  test('nothing is checked out, no expression reaches a script, and the hook URL only travels on stdin', () => {
    expect(SOURCE).not.toMatch(/^\s*-?\s*uses:/m);
    for (const job of [NOTIFY, DIGEST]) {
      expect(job.steps).toHaveLength(1);
      expect(job.steps[0].env.VORFLUX_HOOK_URL).toBe('${{ secrets.VORFLUX_HOOK_URL }}');
      expect(JSON.stringify(job.permissions)).not.toContain('write');
    }
    expect(SOURCE.match(/secrets\./g)).toHaveLength(2);
    for (const script of SCRIPTS) {
      expect(script).not.toContain('${{');
      expect(script).not.toContain('.body');
      expect(script).toContain("printf 'url = \"%s\"\\n' \"$url\" |");
      expect(script).not.toMatch(/curl[^\n]*VORFLUX_HOOK_URL/);
    }
  });
});

describe('job-level if: which events start a runner', () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    ['Capy comment on a Rust engine pull request', 'issue_comment', { issue: issueOn(ember), comment: comment('capy-ai[bot]') }, true],
    ['Capy comment on another pull request', 'issue_comment', { issue: issueOn(other), comment: comment('capy-ai[bot]') }, false],
    ['Capy comment on an issue', 'issue_comment', { issue: { labels: labels('rust-engine') }, comment: comment('capy-ai[bot]') }, false],
    ['unmarked maintainer comment', 'issue_comment', { issue: issueOn(ember), comment: comment('garrytan') }, true],
    ['Vorflux-marked maintainer comment', 'issue_comment', { issue: issueOn(ember), comment: comment('garrytan', 'done <!-- vorflux-session -->') }, false],
    ['comment by someone else', 'issue_comment', { issue: issueOn(ember), comment: comment('alice-example') }, false],
    ['Capy review comment', 'pull_request_review_comment', { pull_request: ember, comment: comment('capy-ai[bot]') }, true],
    ['Capy review comment on a fork head', 'pull_request_review_comment', { pull_request: fork, comment: comment('capy-ai[bot]') }, false],
    ['Capy review', 'pull_request_review', { pull_request: ember, review: { id: 9, user: { login: 'capy-ai[bot]' }, body: '' } }, true],
    ['maintainer review with a body', 'pull_request_review', { pull_request: ember, review: { id: 9, user: { login: 'garrytan' }, body: 'why?' } }, true],
    ['maintainer review with no body', 'pull_request_review', { pull_request: ember, review: { id: 9, user: { login: 'garrytan' }, body: null } }, false],
    ['Rust engine pull request closed', 'pull_request_target', { action: 'closed', pull_request: ember }, true],
    ['other pull request closed', 'pull_request_target', { action: 'closed', pull_request: other }, false],
    ['push to a Rust engine pull request', 'pull_request_target', { action: 'synchronize', pull_request: ember, sender: { login: 'alice-example' } }, false],
    ['failed full-ci Test run', 'workflow_run', { workflow_run: run({}) }, true],
    ['timed-out full-ci E2E run', 'workflow_run', { workflow_run: run({ name: 'E2E Tests', conclusion: 'timed_out' }) }, true],
    ['failed labelled macOS 26 validation run', 'workflow_run', { workflow_run: run({ name: 'macOS 26 validation', event: 'pull_request' }) }, true],
    ['passed full-ci Test run', 'workflow_run', { workflow_run: run({ conclusion: 'success' }) }, false],
    ['cancelled full-ci Test run', 'workflow_run', { workflow_run: run({ conclusion: 'cancelled' }) }, false],
    ['failed cheap-tier Test run on a pull request', 'workflow_run', { workflow_run: run({ event: 'pull_request' }) }, false],
    ['failed Test run from a fork head', 'workflow_run', { workflow_run: run({ head_repository: { full_name: 'someone/gbrain' } }) }, false],
    ['failed scheduled Test run', 'workflow_run', { workflow_run: run({ event: 'schedule' }) }, false],
    ['schedule', 'schedule', { schedule: '5,35 * * * *' }, false],
    ['manual dispatch', 'workflow_dispatch', {}, false],
  ];
  for (const [name, eventName, event, expected] of cases) {
    test(name + (expected ? ' rings at once' : ' starts no notify runner'), () => {
      expect(runs(NOTIFY, eventName, event)).toBe(expected);
    });
  }

  test('the digest job runs only on the schedule and a manual dispatch', () => {
    expect(runs(DIGEST, 'schedule', {})).toBe(true);
    expect(runs(DIGEST, 'workflow_dispatch', {})).toBe(true);
    for (const [, eventName, event] of cases.filter(([, e]) => e !== 'schedule' && e !== 'workflow_dispatch')) {
      expect(runs(DIGEST, eventName, event)).toBe(false);
    }
  });
});

const canRunScripts =
  process.platform !== 'win32' &&
  spawnSync('bash', ['-c', 'command -v jq >/dev/null && date -u -d @0 +%s >/dev/null'], { encoding: 'utf8' }).status === 0;

const FAKE_GH = String.raw`#!/usr/bin/env bash
set -euo pipefail
shift
path=""; expr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --paginate) shift ;;
    --jq) expr=$2; shift 2 ;;
    *) path=$1; shift ;;
  esac
done
echo "gh $path" >> "$FAKE_DIR/calls"
resp=$(jq -ce --arg p "$path" '.[$p]' "$FAKE_DIR/fixtures.json") || { echo "fake gh: no fixture for $path" >&2; exit 1; }
if [ -n "$expr" ]; then jq -r "$expr" <<<"$resp"; else printf '%s\n' "$resp"; fi
`;

const FAKE_CURL = String.raw`#!/usr/bin/env bash
set -euo pipefail
cfg=$(cat)
printf '%s\n' "$*" >> "$FAKE_DIR/curl-argv"
out=""; data=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --data-binary) data=$2; shift 2 ;;
    -H|--connect-timeout|--max-time|--config) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
if [ -z "$url" ]; then
  printf '%s' "$cfg" > "$FAKE_DIR/post-config"
  printf '%s' "$data" > "$FAKE_DIR/post-body"
  [ -z "$out" ] || echo accepted > "$out"
  exit 0
fi
path=$(printf '%s' "$url" | sed 's#^https://api.github.com/##')
echo "curl $path" >> "$FAKE_DIR/calls"
jq -ce --arg p "$path" '.[$p]' "$FAKE_DIR/fixtures.json" || { echo "fake curl: no fixture for $path" >&2; exit 22; }
`;

const HOOK = 'https://hook.example.test/vorflux?token=abc';

function runScript(script: string, env: Record<string, string>, fixtures: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'vorflux-notify-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['gh', FAKE_GH], ['curl', FAKE_CURL]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures));
  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: bin + ':' + process.env.PATH, HOME: dir, FAKE_DIR: dir, RUNNER_TEMP: dir, REPO: 'garrytan/gbrain', GH_TOKEN: 'test-token', ...env },
  });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
  const body = read('post-body');
  return {
    status: res.status,
    out: res.stdout + res.stderr,
    body: body === null ? null : JSON.parse(body),
    rawBody: body,
    config: read('post-config'),
    argv: read('curl-argv') ?? '',
  };
}

describe.skipIf(!canRunScripts)('notify script (fake gh and curl)', () => {
  const NOTIFY_RUN = NOTIFY.steps[0].run as string;
  const sha = 'a'.repeat(40);
  const base = { VORFLUX_HOOK_URL: HOOK, PR_NUMBER: '', COMMENT_ID: '', REVIEW_ID: '', AUTHOR: '', HTML_URL: '', HEAD_SHA: '', MERGED: '', MERGE_SHA: '', RUN_NAME: '', RUN_BRANCH: '', RUN_SUITE: '' };

  test('a Capy comment posts ids only, with the URL on stdin', () => {
    const r = runScript(
      NOTIFY_RUN,
      { ...base, EVENT_NAME: 'issue_comment', PR_NUMBER: '7', COMMENT_ID: '555', AUTHOR: 'capy-ai[bot]', HTML_URL: 'https://github.com/garrytan/gbrain/pull/7#issuecomment-555' },
      { 'repos/garrytan/gbrain/pulls/7': { head: { repo: { full_name: 'garrytan/gbrain' }, sha } } },
    );
    expect(r.status).toBe(0);
    expect(r.body).toEqual({
      repo: 'garrytan/gbrain',
      pr: 7,
      event: 'comment',
      comment_id: 555,
      author: 'capy-ai[bot]',
      head_sha: sha,
      html_url: 'https://github.com/garrytan/gbrain/pull/7#issuecomment-555',
      delivery_id: 'issue_comment:555',
    });
    expect(r.config).toBe('url = "' + HOOK + '"');
    expect(r.argv).not.toContain('hook.example.test');
  });

  test('a merge posts the merge commit with a stable delivery id', () => {
    const r = runScript(NOTIFY_RUN, { ...base, EVENT_NAME: 'pull_request_target', PR_NUMBER: '7', AUTHOR: 'garrytan', HEAD_SHA: sha, MERGED: 'true', MERGE_SHA: 'b'.repeat(40) }, {});
    expect(r.status).toBe(0);
    expect(r.body.event).toBe('merged');
    expect(r.body.delivery_id).toBe('merged:7:' + 'b'.repeat(40));
  });

  const failedRun = { ...base, EVENT_NAME: 'workflow_run', RUN_NAME: 'Test', RUN_BRANCH: 'vorflux/x', RUN_SUITE: '42', HEAD_SHA: sha, AUTHOR: 'garrytan' };
  const pulls = (labelName: string) => [{ number: 7, state: 'open', head: { sha, ref: 'vorflux/x', repo: { full_name: 'garrytan/gbrain' } }, labels: labels(labelName) }];

  test('a red full-suite on the current head of a Rust engine pull request rings', () => {
    const r = runScript(NOTIFY_RUN, failedRun, {
      ['repos/garrytan/gbrain/commits/' + sha + '/pulls']: pulls('rust-engine'),
      ['repos/garrytan/gbrain/commits/' + sha + '/check-runs?filter=latest&check_name=full-suite']: {
        check_runs: [{ check_suite: { id: 42 }, conclusion: 'failure', completed_at: '2026-11-21T10:00:00Z', html_url: 'https://github.com/garrytan/gbrain/runs/1' }],
      },
    });
    expect(r.status).toBe(0);
    expect(r.body).toMatchObject({ pr: 7, event: 'check_failed', delivery_id: 'check_failed:' + sha + ':full-suite', html_url: 'https://github.com/garrytan/gbrain/runs/1' });
  });

  test('a red full run on another pull request sends nothing', () => {
    const r = runScript(NOTIFY_RUN, failedRun, { ['repos/garrytan/gbrain/commits/' + sha + '/pulls']: pulls('bug') });
    expect(r.status).toBe(0);
    expect(r.body).toBeNull();
    expect(r.out).toContain('Nothing sent: no open rust-engine pull request');
  });
});

describe.skipIf(!canRunScripts)('digest script (fake gh and curl)', () => {
  const DIGEST_RUN = DIGEST.steps[0].run as string;
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const IN = '2026-11-21T17:45:00Z';
  const EARLY = '2026-11-21T17:10:00Z';
  const LATE = '2026-11-21T18:00:00Z';
  const R = 'repos/garrytan/gbrain/';
  const START = '2026-11-21T17:30:00Z';
  const since = (start: string) => 'since=' + start + '&per_page=100';
  const SINCE = since(START);
  const runFixtures = (created: string, prev: string | null) => ({
    [R + 'actions/runs/1']: { created_at: created, workflow_id: 77 },
    [R + 'actions/workflows/77/runs?event=schedule&status=success&created=%3C' + created + '&per_page=1']: {
      workflow_runs: prev ? [{ created_at: prev }] : [],
    },
  });
  const pr = (n: number, sha: string, ref: string, repo = 'garrytan/gbrain') => ({ number: n, state: 'open', head: { sha, ref, repo: { full_name: repo } } });
  const issueComment = (id: number, n: number, login: string, created_at = IN) => ({
    id,
    issue_url: 'https://api.github.com/repos/garrytan/gbrain/issues/' + n,
    user: { login },
    created_at,
    body: 'SECRET-COMMENT-TEXT',
  });
  const fixtures = (created: string, prev: string | null = '2026-11-21T17:35:12Z', start = START) => ({
    ...runFixtures(created, prev),
    [R + 'issues?labels=rust-engine&state=open&per_page=100']: [
      { number: 10, updated_at: IN, pull_request: {} },
      { number: 11, updated_at: '2026-11-21T09:00:00Z', pull_request: {} },
      { number: 12, updated_at: IN, pull_request: {} },
      { number: 13, updated_at: IN },
    ],
    [R + 'issues?labels=rust-engine&state=closed&' + since(start)]: [],
    [R + 'pulls/10']: pr(10, A, 'vorflux/a+b'),
    [R + 'pulls/11']: pr(11, B, 'vorflux/quiet'),
    [R + 'pulls/12']: pr(12, A, 'feature', 'someone/gbrain'),
    [R + 'actions/runs?head_sha=' + A + '&status=completed&per_page=100']: {
      workflow_runs: [
        { id: 1, name: 'Test', event: 'workflow_dispatch', conclusion: 'success', updated_at: IN, head_sha: A },
        { id: 2, name: 'Test', event: 'workflow_dispatch', conclusion: 'failure', updated_at: IN, head_sha: A, check_suite_id: 202 },
        { id: 3, name: 'Test', event: 'pull_request', conclusion: 'failure', updated_at: IN, head_sha: A },
        { id: 4, name: 'E2E Tests', event: 'workflow_dispatch', conclusion: 'success', updated_at: LATE, head_sha: A },
        { id: 5, name: 'Semgrep', event: 'pull_request', conclusion: 'success', updated_at: IN, head_sha: A },
        { id: 7, name: 'Test', event: 'workflow_dispatch', conclusion: 'failure', updated_at: IN, head_sha: A, check_suite_id: 207 },
      ],
    },
    [R + 'commits/' + A + '/check-runs?filter=latest&check_name=full-suite']: {
      check_runs: [
        { check_suite: { id: 202 }, conclusion: 'failure', completed_at: IN },
        { check_suite: { id: 207 }, conclusion: 'skipped', completed_at: IN },
      ],
    },
    [R + 'actions/runs?head_sha=' + B + '&status=completed&per_page=100']: {
      workflow_runs: [{ id: 6, name: 'E2E Tests', event: 'workflow_dispatch', conclusion: 'cancelled', updated_at: IN, head_sha: B }],
    },
    [R + 'activity?ref=refs%2Fheads%2Fvorflux%2Fa%2Bb&time_period=day&per_page=100']: [
      { id: 21, activity_type: 'push', actor: { login: 'alice-example' }, timestamp: IN, before: A, after: B },
      { id: 22, activity_type: 'push', actor: { login: 'garrytan' }, timestamp: IN, before: A, after: B },
      { id: 23, activity_type: 'force_push', actor: { login: 'alice-example' }, timestamp: EARLY, before: A, after: B },
      { id: 24, activity_type: 'branch_creation', actor: { login: 'alice-example' }, timestamp: IN, before: A, after: B },
    ],
    [R + 'issues/10/events?per_page=100']: [
      { id: 31, event: 'labeled', actor: { login: 'alice-example' }, label: { name: 'full-ci' }, created_at: IN, commit_id: null },
      { id: 32, event: 'closed', actor: { login: 'alice-example' }, created_at: IN, commit_id: null },
      { id: 33, event: 'mentioned', actor: { login: 'alice-example' }, created_at: IN, commit_id: null },
      { id: 34, event: 'unlabeled', actor: { login: 'alice-example' }, label: { name: 'full-ci' }, created_at: EARLY, commit_id: null },
      { id: 35, event: 'labeled', actor: { login: 'garrytan' }, label: { name: 'full-ci' }, created_at: IN, commit_id: null },
      { id: 36, event: 'unlabeled', actor: { login: 'github-actions[bot]' }, label: { name: 'full-ci' }, created_at: IN, commit_id: null },
      { id: 37, event: 'review_requested', actor: { login: 'capy-ai[bot]' }, created_at: IN, commit_id: null },
    ],
    [R + 'pulls/10/reviews?per_page=100']: [
      { id: 41, user: { login: 'capy-ai[bot]' }, state: 'COMMENTED', submitted_at: IN, body: 'SECRET-REVIEW-TEXT' },
      { id: 42, user: { login: 'alice-example' }, state: 'APPROVED', submitted_at: IN, body: 'SECRET-REVIEW-TEXT' },
      { id: 43, user: { login: 'garrytan' }, state: 'COMMENTED', submitted_at: IN, body: '' },
      { id: 44, user: { login: 'alice-example' }, state: 'PENDING', submitted_at: null, body: '' },
    ],
    [R + 'issues/comments?' + since(start)]: [
      issueComment(51, 10, 'bob-example'),
      issueComment(52, 10, 'capy-ai[bot]'),
      issueComment(53, 12, 'bob-example'),
      issueComment(54, 99, 'bob-example'),
      issueComment(55, 10, 'bob-example', EARLY),
    ],
    [R + 'pulls/comments?' + since(start)]: [
      { id: 61, pull_request_url: 'https://api.github.com/repos/garrytan/gbrain/pulls/10', user: { login: 'bob-example' }, created_at: IN, body: 'SECRET-COMMENT-TEXT' },
      { id: 62, pull_request_url: 'https://api.github.com/repos/garrytan/gbrain/pulls/10', user: { login: 'garrytan' }, created_at: IN, body: 'SECRET-COMMENT-TEXT' },
    ],
  });
  const env = { VORFLUX_HOOK_URL: HOOK, EVENT_NAME: 'schedule', RUN_ID: '1' };

  test('one body for the window that ended at the last half hour, routine events only, no text', () => {
    const r = runScript(DIGEST_RUN, env, fixtures('2026-11-21T18:07:31Z'));
    expect(r.out).toContain('Window 2026-11-21T17:30:00Z to 2026-11-21T18:00:00Z');
    expect(r.status).toBe(0);
    expect(r.rawBody).not.toContain('SECRET');
    expect(r.config).toBe('url = "' + HOOK + '"');
    expect(r.argv).not.toContain('hook.example.test');
    expect(r.body).toEqual({
      repo: 'garrytan/gbrain',
      event: 'digest',
      window_start: '2026-11-21T17:30:00Z',
      window_end: '2026-11-21T18:00:00Z',
      delivery_id: 'digest:2026-11-21T17:30:00Z:2026-11-21T18:00:00Z',
      count: 9,
      truncated: 0,
      items: [
        { pr: 10, kind: 'comment', comment_id: 51, author: 'bob-example' },
        { pr: 10, kind: 'event', event: 'labeled', event_id: 31, author: 'alice-example', label: 'full-ci' },
        { pr: 10, kind: 'push', activity_id: 21, author: 'alice-example', before: A, after: B },
        { pr: 10, kind: 'review', review_id: 42, author: 'alice-example', state: 'APPROVED' },
        { pr: 10, kind: 'review_comment', comment_id: 61, author: 'bob-example' },
        { pr: 10, kind: 'run', run_id: 1, workflow: 'Test', run_event: 'workflow_dispatch', conclusion: 'success', head_sha: A },
        { pr: 10, kind: 'run', run_id: 3, workflow: 'Test', run_event: 'pull_request', conclusion: 'failure', head_sha: A },
        { pr: 10, kind: 'run', run_id: 7, workflow: 'Test', run_event: 'workflow_dispatch', conclusion: 'failure', head_sha: A },
        { pr: 11, kind: 'run', run_id: 6, workflow: 'E2E Tests', run_event: 'workflow_dispatch', conclusion: 'cancelled', head_sha: B },
      ],
    });
  });

  test('a rerun later reads the same window and repeats the delivery id', () => {
    const first = runScript(DIGEST_RUN, env, fixtures('2026-11-21T18:07:31Z'));
    const rerun = runScript(DIGEST_RUN, env, fixtures('2026-11-21T18:29:59Z'));
    expect(rerun.body).toEqual(first.body);
  });

  test('a run delayed past the next half hour, or one after a dropped run, reads every unread half hour', () => {
    const r = runScript(DIGEST_RUN, env, fixtures('2026-11-21T18:07:31Z', '2026-11-21T17:05:02Z', '2026-11-21T17:00:00Z'));
    expect(r.status).toBe(0);
    expect(r.out).toContain('Window 2026-11-21T17:00:00Z to 2026-11-21T18:00:00Z');
    expect(r.body.delivery_id).toBe('digest:2026-11-21T17:00:00Z:2026-11-21T18:00:00Z');
    expect(r.body.items).toContainEqual({ pr: 10, kind: 'comment', comment_id: 55, author: 'bob-example' });
    expect(r.body.items).toContainEqual({ pr: 10, kind: 'force_push', activity_id: 23, author: 'alice-example', before: A, after: B });
  });

  test('catching up reaches back at most six hours, and a first run reads one half hour', () => {
    const late = runScript(DIGEST_RUN, env, fixtures('2026-11-21T18:07:31Z', '2026-11-19T09:05:00Z', '2026-11-21T12:00:00Z'));
    expect(late.out).toContain('Window 2026-11-21T12:00:00Z to 2026-11-21T18:00:00Z');
    const first = runScript(DIGEST_RUN, env, fixtures('2026-11-21T18:07:31Z', null));
    expect(first.out).toContain('Window 2026-11-21T17:30:00Z to 2026-11-21T18:00:00Z');
  });

  test('a run in a half hour an earlier run already read posts nothing', () => {
    const r = runScript(DIGEST_RUN, env, runFixtures('2026-11-21T18:07:31Z', '2026-11-21T18:01:40Z'));
    expect(r.status).toBe(0);
    expect(r.body).toBeNull();
    expect(r.out).toContain('Nothing sent: an earlier scheduled run already read up to 2026-11-21T18:00:00Z');
  });

  test('a failed pull request listing fails the run instead of reading an empty window', () => {
    const all = fixtures('2026-11-21T18:07:31Z');
    delete (all as Record<string, unknown>)[R + 'issues?labels=rust-engine&state=open&per_page=100'];
    const r = runScript(DIGEST_RUN, env, all);
    expect(r.status).not.toBe(0);
    expect(r.body).toBeNull();
  });

  test('an empty window posts nothing', () => {
    const r = runScript(DIGEST_RUN, env, {
      ...runFixtures('2026-11-21T18:07:31Z', '2026-11-21T17:35:12Z'),
      [R + 'issues?labels=rust-engine&state=open&per_page=100']: [],
      [R + 'issues?labels=rust-engine&state=closed&' + SINCE]: [],
      [R + 'issues/comments?' + SINCE]: [],
      [R + 'pulls/comments?' + SINCE]: [],
    });
    expect(r.status).toBe(0);
    expect(r.body).toBeNull();
    expect(r.out).toContain('Nothing sent: no Rust engine pull request had routine events');
  });

  test('a manual dispatch prints the digest and posts nothing, even without the secret', () => {
    const r = runScript(DIGEST_RUN, { ...env, EVENT_NAME: 'workflow_dispatch', VORFLUX_HOOK_URL: '' }, fixtures('2026-11-21T18:07:31Z'));
    expect(r.status).toBe(0);
    expect(r.body).toBeNull();
    expect(r.out).toContain('Dry run (manual dispatch), nothing sent: {');
  });

  test('a scheduled run with no secret fails loudly', () => {
    const r = runScript(DIGEST_RUN, { ...env, VORFLUX_HOOK_URL: '' }, fixtures('2026-11-21T18:07:31Z'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('The VORFLUX_HOOK_URL secret is empty');
  });
});

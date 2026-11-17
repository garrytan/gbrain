/**
 * `bindInput` (src/eval/longmemeval/call-plan.ts) decides whether a dataset, question-ID or replay file the caller
 * names is pinned to HEAD as an INPUT line of the call plan, or recorded as a PRECONDITION with its bytes' sha256.
 * Protects: a tracked, unmodified file in a first folder named `..inputs` binds as an INPUT line with its repo path,
 * while a modified file there, an untracked file there, a file outside the repository and a file in a sibling folder
 * that shares the repository's name prefix stay PRECONDITIONs.
 * Authoring gate: (1) whether a tracked input is pinned to the commit or left as an unpinned precondition; (2) a
 * startsWith('..') check that is not component-aware treats `..inputs/questions.jsonl` as outside the repository;
 * (3) eval-longmemeval-call-plan.test.ts binds only test/fixtures/longmemeval-mini.jsonl, whose first folder is
 * `test`; (4) seam: `bindInput` is exported for this test. The command boundary binds against the gbrain checkout
 * that runs it, which has no committed `..inputs` folder, so the boundary cannot reach this case; the test drives the
 * exported function on a real temporary Git repository instead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bindInput, type CallPlan } from '../src/eval/longmemeval/call-plan.ts';
import { gitChildEnv } from '../src/core/git-env.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function put(root: string, path: string, body: string): string {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/** `<dir>/repo` with `..inputs/questions.jsonl` and `data/plain.jsonl` committed; `<dir>/repo2` is a name-prefix sibling. */
function repo(): { dir: string; root: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-lme-dotdot-')));
  dirs.push(dir);
  const root = join(dir, 'repo');
  git(dir, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'core.hooksPath', join(dir, 'hooks'));
  put(root, '..inputs/questions.jsonl', '{"question_id":"q1"}\n');
  put(root, 'data/plain.jsonl', '{"question_id":"q2"}\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  return { dir, root };
}

const emptyPlan = (): CallPlan => ({ gate: 'gate', head: 'head', inputs: [], preconditions: [], rows: [] });
const sha = (body: string) => createHash('sha256').update(body).digest('hex');

describe('call plan input binding with a first folder named ..inputs', () => {
  test('a tracked, unmodified ..inputs file binds as an INPUT line', () => {
    const { root } = repo();
    const plan = emptyPlan();
    bindInput(root, join(root, '..inputs', 'questions.jsonl'), 'dataset', plan);
    expect(plan.inputs).toEqual([{ path: '..inputs/questions.jsonl', sha256: sha('{"question_id":"q1"}\n') }]);
    expect(plan.preconditions).toEqual([]);
  });

  test('a tracked file in an ordinary folder binds the same way (control)', () => {
    const { root } = repo();
    const plan = emptyPlan();
    bindInput(root, join(root, 'data', 'plain.jsonl'), 'dataset', plan);
    expect(plan.inputs.map(i => i.path)).toEqual(['data/plain.jsonl']);
  });

  test('modified, untracked, outside and name-prefix sibling files stay PRECONDITIONs', () => {
    const { dir, root } = repo();
    put(root, '..inputs/questions.jsonl', '{"question_id":"changed"}\n');
    const files = [
      join(root, '..inputs', 'questions.jsonl'),
      put(root, '..inputs/untracked.jsonl', 'u\n'),
      put(dir, 'outside/q.jsonl', 'o\n'),
      put(dir, 'repo2/q.jsonl', 's\n'),
      join(root, '..', 'outside', 'q.jsonl'),
    ];
    const plan = emptyPlan();
    for (const f of files) bindInput(root, f, 'dataset', plan);
    expect(plan.inputs).toEqual([]);
    expect(plan.preconditions).toHaveLength(files.length);
    expect(plan.preconditions[0]).toContain(`dataset questions.jsonl sha256=${sha('{"question_id":"changed"}\n')} is not a tracked unmodified file`);
  });
});

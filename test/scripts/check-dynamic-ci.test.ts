/**
 * scripts/check-dynamic-ci.ts (docs/ci-event-parity.md#trunk-dynamic-ci): the
 * Trunk Dynamic CI filter runs only on pull_request, fails open, and gates only
 * jobs whose if keeps the !cancelled() && != 'false' form. Each case breaks the
 * real test.yml one way and expects the guard to name it; the real tree passes.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { checkCallers, checkWorkflow } from '../../scripts/check-dynamic-ci.ts';

const REPO = resolve(import.meta.dir, '..', '..');
type Doc = { on: Record<string, unknown>; jobs: Record<string, Record<string, any>> };
const real = (name: string) => load(readFileSync(join(REPO, '.github/workflows', name), 'utf8')) as Doc;
const broken = (mutate: (doc: Doc) => void, name = 'test.yml') => { const doc = structuredClone(real(name)); mutate(doc); return checkWorkflow(name, doc); };
const filterStep = (doc: Doc) => doc.jobs['dynamic-ci']!.steps.find((s: { uses?: string }) => s.uses?.startsWith('trunk-io/dynamic-ci@'));

describe('check-dynamic-ci.ts', () => {
  test('the real workflows pass', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts/check-dynamic-ci.ts')], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: '' } });
    expect(r.status, r.stderr).toBe(0);
    expect(checkWorkflow('test.yml', real('test.yml'))).toEqual([]);
    expect(checkWorkflow('scale-tier.yml', real('scale-tier.yml'))).toEqual([]);
    for (const name of ['persistence-validation.yml', 'tla-spec.yml']) expect(checkWorkflow(name, real(name))).toEqual([]);
  });

  test.each<[string, (doc: Doc) => void, RegExp]>([
    ['the filter runs on every event', doc => { delete doc.jobs['dynamic-ci']!.if; }, /must have if: github.event_name == 'pull_request'/],
    ['the filter also runs on pushes', doc => { doc.jobs['dynamic-ci']!.if = "github.event_name == 'pull_request' || github.event_name == 'push'"; }, /must have if: github.event_name == 'pull_request'/],
    ['the filter is in a workflow without a pull_request trigger', doc => { delete doc.on.pull_request; }, /no pull_request trigger and is not a reusable workflow/],
    ['the action is not pinned to a SHA', doc => { filterStep(doc).uses = 'trunk-io/dynamic-ci@v1'; }, /full commit SHA/],
    ['the token is not the repo secret', doc => { filterStep(doc).with.token = 'abc'; }, /secrets\.TRUNK_API_TOKEN/],
    ['job-keys and outputs disagree', doc => { filterStep(doc).with['job-keys'] = 'native-locks'; }, /job-keys \[native-locks\] must name exactly/],
    ['an output reads the wrong step output', doc => { doc.jobs['dynamic-ci']!.outputs['native-locks'] = '${{ steps.dynamic-ci.outputs.verify }}'; }, /output native-locks must be/],
    ['a gated job drops !cancelled()', doc => { doc.jobs['stress-changed-tests']!.if = doc.jobs['stress-changed-tests']!.if.replace('!cancelled() && ', ''); }, /stress-changed-tests: a gated job's if must start with/],
    ['a gated job tests == true instead of != false', doc => { doc.jobs['native-locks']!.if = doc.jobs['native-locks']!.if.replace("!= 'false'", "== 'true'"); }, /native-locks: a gated job's if must start with/],
    ['a gated job drops its other needs check', doc => { doc.jobs['native-locks']!.if = doc.jobs['native-locks']!.if.replace("needs.changes.result == 'success' && ", ''); }, /add needs\.changes\.result == 'success'/],
    ['a gated job adds always()', doc => { doc.jobs['security-regressions']!.if = doc.jobs['security-regressions']!.if.replace("!= 'false' && ", "!= 'false' && always() && "); }, /no other status function/],
    ['a gated job forgets to need the filter', doc => { doc.jobs['security-regressions']!.needs = []; }, /security-regressions: a gated job must list dynamic-ci in needs/],
    ['an aggregate is gated', doc => { doc.jobs['dynamic-ci']!.outputs['full-suite'] = '${{ steps.dynamic-ci.outputs.full-suite }}'; filterStep(doc).with['job-keys'] += ',full-suite'; }, /full-suite: merge and release aggregates are never gated/],
    ['the dynamic-ci step can fail the job', doc => { delete filterStep(doc)['continue-on-error']; }, /needs continue-on-error: true/],
    ['the dynamic-ci step has no timeout of its own', doc => { delete filterStep(doc)['timeout-minutes']; }, /needs a timeout-minutes below the job's/],
    ['the dynamic-ci step timeout is not below the job timeout', doc => { filterStep(doc)['timeout-minutes'] = 5; }, /needs a timeout-minutes below the job's/],
    ['the dynamic-ci step has no id', doc => { delete filterStep(doc).id; }, /the dynamic-ci step needs an id/],
    ['an output names no job', doc => { doc.jobs['dynamic-ci']!.outputs.ghost = '${{ steps.dynamic-ci.outputs.ghost }}'; filterStep(doc).with['job-keys'] += ',ghost'; }, /output ghost names no job/],
    ['a gated job ORs past the gate', doc => { doc.jobs['native-locks']!.if = doc.jobs['native-locks']!.if.replace(/ \}\}$/, " || github.event_name == 'push' }}"); }, /native-locks: wrap the condition after the gate prefix in parentheses/],
    ['a non-aggregate job reads the verdicts', doc => { doc.jobs.verify!.needs = ['dynamic-ci']; }, /verify: needs dynamic-ci but is not one of its outputs/],
  ])('fails when %s', (_, mutate, message) => {
    const problems = broken(mutate);
    expect(problems.join('\n')).toMatch(message);
  });

  test.each<[string, (doc: Doc) => void, RegExp]>([
    ['the reusable workflow loses its workflow_call trigger', doc => { delete doc.on.workflow_call; }, /no pull_request trigger and is not a reusable workflow/],
    ['the called filter runs on every event', doc => { delete doc.jobs['dynamic-ci']!.if; }, /must have if: github.event_name == 'pull_request'/],
    ['a called gated job drops !cancelled()', doc => { doc.jobs.convergence!.if = doc.jobs.convergence!.if.replace('!cancelled() && ', ''); }, /convergence: a gated job's if must start with/],
    ['the called filter job can fail the call', doc => { delete doc.jobs['dynamic-ci']!['continue-on-error']; }, /needs job-level continue-on-error: true/],
    ['a gate-only if tests == true', doc => { doc.jobs['crash-robot']!.if = doc.jobs['crash-robot']!.if.replace("!= 'false'", "== 'true'"); }, /crash-robot: a gated job's if must start with/],
  ])('persistence-validation.yml fails when %s', (_, mutate, message) => {
    expect(broken(mutate, 'persistence-validation.yml').join('\n')).toMatch(message);
  });

  // A caller that drops the token makes the called filter fail open on every run: nothing goes red and Trunk never learns.
  const docs = () => ({ 'test.yml': real('test.yml'), 'persistence-validation.yml': real('persistence-validation.yml') });
  test('every caller of a reusable workflow with a filter passes the token and grants pull-requests: read', () => {
    expect(checkCallers(docs())).toEqual([]);
  });
  test.each<[string, (d: Record<string, Doc>) => void, RegExp]>([
    ['the caller drops the token', d => { delete d['test.yml']!.jobs['persistence-validation']!.secrets; }, /test\.yml › persistence-validation: calls persistence-validation\.yml, whose Dynamic CI filter needs the token/],
    ['the caller passes another secret', d => { d['test.yml']!.jobs['persistence-validation']!.secrets = { TRUNK_API_TOKEN: '${{ secrets.OTHER }}' }; }, /whose Dynamic CI filter needs the token/],
    ['the caller drops pull-requests: read', d => { delete d['test.yml']!.jobs['persistence-validation']!.permissions; }, /asks for pull-requests: read/],
    ['no permissions are set at job or workflow level', d => { delete d['test.yml']!.jobs['persistence-validation']!.permissions; delete (d['test.yml'] as any).permissions; }, /asks for pull-requests: read; grant it explicitly/],
    ['the reusable workflow makes the token required', d => { (d['persistence-validation.yml']!.on.workflow_call as any).secrets.TRUNK_API_TOKEN.required = true; }, /must declare on\.workflow_call\.secrets\.TRUNK_API_TOKEN with required: false/],
  ])('the caller check fails when %s', (_, mutate, message) => {
    const d = structuredClone(docs());
    mutate(d);
    expect(checkCallers(d).join('\n')).toMatch(message);
  });
  test('secrets: inherit passes the token', () => {
    const d = structuredClone(docs());
    d['test.yml']!.jobs['persistence-validation']!.secrets = 'inherit';
    expect(checkCallers(d)).toEqual([]);
  });
});

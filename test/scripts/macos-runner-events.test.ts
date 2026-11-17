/**
 * Which events start GitHub's macOS runners in test.yml and native-locks.yml (GST-2926, decisions A and B).
 * A pull request's cheap tier starts no macOS job; a master push that reuses a passed full run of its exact tree skips
 * the macOS security-regressions cell; the full-ci dispatch, a master push that does not reuse, the nightly schedule
 * and the merge queue still run every macOS cell. Evaluates the workflows' own matrix exclude and job if expressions.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { load as loadYaml } from 'js-yaml';

type Matrix = Record<string, unknown> & { exclude?: unknown };
type Job = { if?: string; needs?: string[]; strategy?: { matrix: Matrix } };
const root = join(import.meta.dir, '../..');
const load = (name: string) => loadYaml(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const strip = (expression: string) => expression.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replace(/\.([A-Za-z_]\w*(?:-\w+)+)/g, "['$1']");

interface Event { event_name: string; reuse?: string; scope?: string }
const context = (e: Event) => ({
  fromJSON: (text: string) => JSON.parse(text),
  cancelled: () => false,
  always: () => true,
  github: { event_name: e.event_name },
  inputs: { scope: e.scope ?? 'full', native_only: false, race_hunt: false, stress_files: '', stress_base: '' },
  needs: {
    changes: { result: 'success', outputs: { reuse: e.reuse ?? '', 'native-scope': e.scope ?? 'full' } },
    'dynamic-ci': { result: e.event_name === 'pull_request' ? 'success' : 'skipped', outputs: { 'security-regressions': '', 'native-locks': '' } },
  },
});
const evaluate = (expression: string, e: Event) => runInNewContext(strip(expression), context(e), { timeout: 100 });

/** The matrix cells a job starts for event `e`, or [] when its if skips it. */
function cells(job: Job, e: Event): Array<Record<string, string>> {
  if (job.if !== undefined && !evaluate(job.if, e)) return [];
  if (!job.strategy) return [{}];
  const { exclude, include: _include, ...axes } = job.strategy!.matrix;
  const excluded = (typeof exclude === 'string' ? evaluate(exclude, e) : exclude ?? []) as Array<Record<string, string>>;
  let out: Array<Record<string, string>> = [{}];
  for (const [axis, values] of Object.entries(axes)) out = out.flatMap(cell => (values as string[]).map(v => ({ ...cell, [axis]: v })));
  return out.filter(cell => !excluded.some(x => Object.entries(x).every(([k, v]) => cell[k] === v)));
}

const test_ = load('test.yml');
const native = load('native-locks.yml');
const security = (e: Event) => cells(test_.jobs['security-regressions']!, e).map(c => c.os);
const darwin = (e: Event) => cells(native.jobs.native!, e).map(c => c.target).filter(t => t!.startsWith('darwin'));

describe('macOS jobs by event (GST-2926)', () => {
  test('a pull request push starts no macOS job: no macos-26 security cell and no darwin native cell', () => {
    expect(security({ event_name: 'pull_request' })).toEqual(['ubuntu-latest', 'windows-latest']);
    expect(darwin({ event_name: 'pull_request', scope: 'primary' })).toEqual([]);
    expect(cells(native.jobs.native!, { event_name: 'pull_request', scope: 'primary' }).map(c => c.target)).toEqual(['linux-x64-glibc', 'linux-arm64-glibc', 'win32-x64', 'win32-arm64']);
    expect(darwin({ event_name: 'pull_request', scope: 'smoke' })).toEqual([]);
    expect(cells(native.jobs['heartbeat-finalize']!, { event_name: 'pull_request', scope: 'primary' })).toEqual([]);
  });

  test('a master push that reuses a passed full run skips the macOS security cell and the native lanes', () => {
    expect(security({ event_name: 'push', reuse: 'true' })).toEqual(['ubuntu-latest', 'windows-latest']);
    expect(evaluate(test_.jobs['native-locks']!.if!, { event_name: 'push', reuse: 'true' })).toBe(false);
  });

  test('the full-ci dispatch, a master push that does not reuse, the nightly and the merge queue run every macOS cell', () => {
    for (const e of [{ event_name: 'workflow_dispatch' }, { event_name: 'push', reuse: 'false' }, { event_name: 'push' }, { event_name: 'schedule' }, { event_name: 'merge_group', scope: 'primary' }]) {
      expect(security(e)).toEqual(['ubuntu-latest', 'macos-26', 'windows-latest']);
      expect(darwin({ scope: 'full', ...e })).toEqual(['darwin-arm64', 'darwin-x64']);
    }
    expect(cells(native.jobs['heartbeat-finalize']!, { event_name: 'workflow_dispatch' })).toEqual([{}]);
  });
});

#!/usr/bin/env bun
/**
 * scripts/ci-unit-suite-gate.ts — the always-run `unit-suite-gate` check in test.yml (docs/ci-event-parity.md#unit-suite-gate).
 *
 *   bun scripts/ci-unit-suite-gate.ts scope --files <pr-files.ndjson> --changed <n> --policy .gstack/ship-policy.json
 *     prints `skip` when a pull request changes only changelog entries or only release stamps (VERSION, the
 *     ship policy's stamp files with only stamp-pattern lines changed, changelog entries), else `run`. Fails closed:
 *     an incomplete file list, a file without a patch or any other line prints `run`.
 *   bun scripts/ci-unit-suite-gate.ts judge
 *     reads EVENT, TEST_RESULT, REUSE and UNIT from the environment and exits 1 when the unit suite did not pass
 *     and was not rightly skipped.
 */
import { readFileSync } from 'node:fs';

export type PrFile = { filename: string; status?: string; patch?: string; previous_filename?: string };
export type Policy = { stamp_files?: string[]; stamp_patterns?: string[] };
export type Scope = { unit: 'skip' | 'run'; why: string };

const CHANGELOG = /^(changelog\.d\/[^/]+\.md|CHANGELOG\.md)$/;
const VERSION = /^\d+(?:\.\d+){2,3}$/;

function changedLines(patch: string): string[] {
  return patch.split('\n').filter(line => /^[+-]/.test(line)).map(line => line.slice(1));
}

function globMatches(glob: string, path: string): boolean {
  const want = glob.split('/');
  const got = path.split('/');
  return want.length === got.length && want.every((part, i) => part === got[i] || (part === '*' && got[i] !== ''));
}

function stampMatches(pattern: string, line: string): boolean {
  const [before, after = ''] = pattern.split('{version}');
  const trimmed = line.trim();
  const text = after.endsWith('"') && trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
  if (text.length < before!.length + after.length || !text.startsWith(before!) || !text.endsWith(after)) return false;
  return VERSION.test(text.slice(before!.length, text.length - after.length));
}

export function unitScope(files: PrFile[], changed: number, policy: Policy): Scope {
  if (!files.length || files.length !== changed) return { unit: 'run', why: `the file list has ${files.length} of ${changed} files` };
  const patterns = (policy.stamp_patterns ?? []).filter(pattern => pattern.includes('{version}'));
  let stamps = false;
  for (const file of files) {
    if (CHANGELOG.test(file.filename) && (!file.previous_filename || CHANGELOG.test(file.previous_filename))) continue;
    if (file.status === 'renamed' || file.status === 'removed' || file.status === 'added' || typeof file.patch !== 'string') return { unit: 'run', why: `${file.filename} is not a stamp-only change` };
    const lines = changedLines(file.patch);
    const ok = file.filename === 'VERSION'
      ? lines.every(line => VERSION.test(line.trim()))
      : (policy.stamp_files ?? []).some(glob => globMatches(glob, file.filename)) && lines.every(line => patterns.some(pattern => stampMatches(pattern, line)));
    if (!lines.length || !ok) return { unit: 'run', why: `${file.filename} changes more than a release stamp` };
    stamps = true;
  }
  return { unit: 'skip', why: stamps ? 'release-only: only release stamps and changelog entries change' : 'changelog-only: only changelog entries change' };
}

export type Verdict = { gate: boolean; ok: boolean; why: string };

export function judge(input: { event: string; test: string; reuse?: string; unit?: string }): Verdict {
  if (input.event === 'pull_request') {
    if (input.unit === 'skip') return { gate: true, ok: true, why: 'the unit suite is rightly skipped: this pull request changes only changelog entries or release stamps' };
    return { gate: false, ok: true, why: 'a pull request runs the cheap tier; the full-ci dispatch on this head runs the unit suite and reports unit-suite-gate' };
  }
  if (input.test === 'success') return { gate: true, ok: true, why: 'the unit suite passed' };
  if (input.test === 'skipped' && input.reuse === 'true') return { gate: true, ok: true, why: 'the unit suite is rightly skipped: this push reuses a passed full run of its exact tree' };
  return { gate: true, ok: false, why: `the unit suite did not pass (test: ${input.test || 'unknown'})` };
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'scope') {
    let scope: Scope;
    try {
      const files = readFileSync(flag(args, '--files')!, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as PrFile);
      const policy = JSON.parse(readFileSync(flag(args, '--policy') ?? '.gstack/ship-policy.json', 'utf8')) as Policy;
      scope = unitScope(files, Number(flag(args, '--changed')), policy);
    } catch (error) {
      scope = { unit: 'run', why: `the file list could not be read (${(error as Error).message.split('\n')[0]})` };
    }
    console.error(`unit suite scope: ${scope.unit} (${scope.why})`);
    console.log(scope.unit);
  } else if (command === 'judge') {
    const env = process.env;
    const verdict = judge({ event: env.EVENT ?? '', test: env.TEST_RESULT ?? '', reuse: env.REUSE, unit: env.UNIT });
    console.log(`${verdict.gate ? 'unit-suite-gate' : 'unit-suite-not-run'}: ${verdict.why}`);
    if (env.GITHUB_STEP_SUMMARY) Bun.write(env.GITHUB_STEP_SUMMARY, `${verdict.gate ? 'unit-suite-gate' : 'unit-suite-not-run'}: ${verdict.why}\n`);
    if (!verdict.ok) console.log(`::error::unit-suite-gate fails: ${verdict.why}`);
    process.exit(verdict.ok ? 0 : 1);
  } else {
    console.error('usage: bun scripts/ci-unit-suite-gate.ts scope --files <ndjson> --changed <n> [--policy <file>] | judge');
    process.exit(2);
  }
}

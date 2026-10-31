/**
 * Upgrade matrix (GBRA-224 W2): judging a cell, applying known exceptions and
 * summarizing a run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every check a cell can fail, with the upgrade-breakage class it guards (plan "What caused this work", item 2). */
export const CHECKS = {
  setup: 'harness: the old release could not be installed, initialized or seeded (no candidate verdict)',
  interposition: 'D: the updater saw a commit other than the candidate, or the fixture could not serve it',
  upgrade: 'D/E: the old release\'s updater failed after the documented fix',
  installed_build: 'D: the installed build is not the candidate commit',
  one_build: 'C: a process still runs the old build after the upgrade and restart',
  apply_migrations: 'A/G: apply-migrations did not exit 0',
  schema_head: 'A: the schema is not at the candidate\'s head',
  doctor: 'H: doctor reports a failing check outside the skill category',
  serve: 'C/E: the restarted serve does not answer MCP on the candidate build',
  write: 'J: a new page could not be written',
  keyword_search: 'J: keyword search does not find a page',
  vector_search: 'J: vector search or embedding failed (keyed)',
  dream: 'J: a post-upgrade maintenance pass failed',
  preservation: 'data loss: canonical content changed across the upgrade',
  mixed_version: 'C: the old binary changed schema or content on the upgraded brain',
} as const;
export type Check = keyof typeof CHECKS;

export interface Failure { check: Check; detail: string }
export interface KnownException { id: string; check: Check; from: string[]; issue: string; reason: string }

export const KNOWN_EXCEPTIONS_FILE = join(import.meta.dir, 'known-exceptions.json');

/** Every entry names an explicit from-version list, a known check and an issue; no wildcards. */
export function validateKnownExceptions(entries: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(entries)) return ['known-exceptions.json: "exceptions" must be an array'];
  entries.forEach((e: any, i) => {
    const at = 'exception ' + i + (e?.id ? ' (' + e.id + ')' : '');
    if (typeof e?.id !== 'string' || !e.id) problems.push(at + ': id is required');
    if (!(e?.check in CHECKS)) problems.push(at + ': check must be one of ' + Object.keys(CHECKS).join(', '));
    if (e?.check === 'setup') problems.push(at + ': setup errors are never excepted');
    if (!Array.isArray(e?.from) || e.from.length === 0 || e.from.some((v: unknown) => typeof v !== 'string' || !/^v\d+\.\d+\.\d+(\.\d+)?$/.test(v))) problems.push(at + ': from must list explicit release tags (v<x.y.z.w>), no wildcards');
    if (typeof e?.issue !== 'string' || !/^https:\/\/github\.com\/garrytan\/gbrain\/(issues|pull)\/\d+$/.test(e.issue)) problems.push(at + ': issue must be a garrytan/gbrain issue or pull URL');
    if (typeof e?.reason !== 'string' || e.reason.length < 20) problems.push(at + ': reason must say what the old release does');
  });
  return problems;
}

export function loadKnownExceptions(file = KNOWN_EXCEPTIONS_FILE): KnownException[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { exceptions: unknown };
  const problems = validateKnownExceptions(parsed.exceptions);
  if (problems.length) throw new Error(problems.join('\n'));
  return parsed.exceptions as KnownException[];
}

// W4 SWITCH POINT (GBRA-224 W4 adds doctor --alert): when it ships, change
// DOCTOR_ARGV to ['doctor', '--alert', '--json'] and drop the legacy branch in
// doctorVerdict. Until then the verdict is the legacy report: any check whose
// status is fail outside the skill category fails the cell. A report that
// already carries alert.level is judged by it.
export const DOCTOR_ARGV = ['doctor', '--json'];

export function doctorVerdict(report: any): { ok: boolean; failing: string[]; source: 'alert' | 'legacy' } {
  const level = report?.alert?.level;
  if (typeof level === 'string') {
    const items = Array.isArray(report.alert.items) ? report.alert.items.map((i: any) => String(i?.code ?? i?.check ?? 'item')) : [];
    return { ok: level === 'none', failing: level === 'none' ? [] : [level, ...items], source: 'alert' };
  }
  const checks: any[] = Array.isArray(report?.checks) ? report.checks : [];
  const failing = checks.filter(c => c?.status === 'fail' && c?.category !== 'skill').map(c => String(c.name) + ': ' + String(c.message ?? '').slice(0, 200));
  return { ok: !!report && failing.length === 0, failing, source: 'legacy' };
}

export type CellVerdict = 'pass' | 'fail' | 'error' | 'known_exception';

/** fail/error unless every failure matches a known exception for this from-version. */
export function judgeCell(fromTag: string, failures: Failure[], exceptions: KnownException[]): { verdict: CellVerdict; excepted: Array<Failure & { exception: string; issue: string }>; open: Failure[] } {
  const excepted: Array<Failure & { exception: string; issue: string }> = [];
  const open: Failure[] = [];
  for (const f of failures) {
    const e = exceptions.find(x => x.check === f.check && x.from.includes(fromTag));
    if (e) excepted.push({ ...f, exception: e.id, issue: e.issue });
    else open.push(f);
  }
  const verdict: CellVerdict = open.some(f => f.check === 'setup') ? 'error' : open.length ? 'fail' : excepted.length ? 'known_exception' : 'pass';
  return { verdict, excepted, open };
}

export interface CellSummary { id: string; from: string; roles: string[]; shape: string; verdict: CellVerdict | 'hold' | 'missing'; open: Failure[]; excepted: Array<{ check: string; issue: string }>; fault?: string | null }

/**
 * Red: a cell failed a candidate check, a planned cell left no receipt, or a
 * fault was injected. Hold: a cell could not reach a candidate verdict because
 * the old release could not be installed, initialized or seeded in that shape
 * (error), or a door could not run. Green: every planned cell passed or failed
 * only a known exception. A hold never passes a gate and never opens an
 * upgrade-break issue.
 */
export function summarize(planned: string[], cells: CellSummary[]): { green: boolean; red: CellSummary[]; holds: CellSummary[] } {
  const byId = new Map(cells.map(c => [c.id, c]));
  const all = planned.map(id => byId.get(id) ?? { id, from: '?', roles: [], shape: '?', verdict: 'missing' as const, open: [], excepted: [] });
  const red = all.filter(c => c.fault || c.verdict === 'fail' || c.verdict === 'missing');
  const holds = all.filter(c => !red.includes(c) && (c.verdict === 'hold' || c.verdict === 'error'));
  return { green: red.length === 0 && holds.length === 0, red, holds };
}

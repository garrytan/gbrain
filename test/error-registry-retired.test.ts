/**
 * #6712 (DX): a retired surface never stays in a printed fix. `knock_on_exhausted` used to tell agents to raise
 * `sync.knock_on_refreeze_limit` / `sync.knock_on_run_limit`; #6712 deleted both keys with the knock-on re-freeze budget,
 * so the code is a tombstone (`retired_in`) whose fix points at a plain sync.
 *
 * Protects: no registered fix, suggestion, `why`, fault-table reason or terminal-classifier action names a retired
 * config key; every `--flag` a registered fix argv passes to `gbrain` is a flag that command still accepts; a retired
 * code's fix is read-only and needs no consent; the retired keys are no longer accepted by `config set`.
 * #6712 PR 2 extends it to the sync config-key table: no source line outside the table and the historical behavior
 * notices names a retired key (help text, doctor messages, hold reasons and refusals included), and `gbrain sync --help`
 * and `gbrain config --help` name neither a retired key nor a rollback key (rollback keys are not tunables).
 * #6712 PR 3 (L7) extends it to `gbrain sync --retry-failed`, now a deprecated alias of the plain sync: no registered fix,
 * fault-table reason, source string or sync help line outside the flag's own deprecation entry tells a Git sync to pass it.
 */
import { expect, test } from 'bun:test';
import { CODES, NOTICE_CODES, type CodeEntry } from '../src/core/error-registry.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { SYNC_FAULT_TABLE } from '../src/core/persistence/sync-fault-class.ts';
import { classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { knockOnDetail } from '../src/core/persistence/sync-knock-on.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { RETIRED_SYNC_KEYS, SYNC_ROLLBACK_KEYS } from '../src/core/sync-config-keys.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Config keys a release retired (src/core/sync-config-keys.ts); a printed fix must never name them. Retire a key there. */
const RETIRED_KEYS = Object.keys(RETIRED_SYNC_KEYS);

const entries = (registry: Record<string, unknown>) => Object.entries(registry) as Array<[string, CodeEntry]>;
const fixText = (entry: CodeEntry) => [entry.suggestion, entry.why, ...(entry.fix ? [(entry.fix.argv ?? []).join(' '), entry.fix.why] : [])].filter(Boolean).join('\n');

test('no registered fix, suggestion or reason names a retired config key', () => {
  const texts: Array<[string, string]> = [
    ...entries(CODES).map(([code, entry]) => [`CODES.${code}`, fixText(entry)] as [string, string]),
    ...entries(NOTICE_CODES).map(([code, entry]) => [`NOTICE_CODES.${code}`, fixText(entry)] as [string, string]),
    ...SYNC_FAULT_TABLE.map(rule => [`SYNC_FAULT_TABLE.${rule.code}`, `${rule.human_reason ?? ''}\n${rule.escalate}`] as [string, string]),
  ];
  // The terminal classifier's verdict for a legacy knock-on receipt (the only producer of the retired budget's text).
  const verdict = classifyTerminal({ request_id: 'r', source_id: 'default', slug: 's', operation: 'submit_job', state: 'cancelled', error_code: 'cancelled',
    error_detail: knockOnDetail('window_predecessor', null), recovery: null, blocked_reason: null, compacted: false, publication_started: false,
    intent_kind: 'managed_sync_import', error_message: null });
  expect(verdict).toBeTruthy();
  texts.push(['classifyTerminal(knock_on)', JSON.stringify(verdict)]);
  const named = texts.flatMap(([where, text]) => RETIRED_KEYS.filter(key => text.includes(key)).map(key => `${where} names ${key}`));
  expect(named).toEqual([]);
});

test('the retired config keys are no longer accepted', () => {
  for (const key of RETIRED_KEYS) expect(KNOWN_CONFIG_KEYS).not.toContain(key);
});

test('every flag a registered fix passes to gbrain is one that command still accepts', () => {
  const unknown: string[] = [];
  for (const [code, entry] of [...entries(CODES), ...entries(NOTICE_CODES)]) {
    const argv = entry.fix?.argv;
    if (!argv || argv[0] !== 'gbrain' || !argv[1] || !CLI_FLAG_REGISTRY[argv[1]]) continue;
    for (const flag of argv.slice(2).filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]!)) {
      if (!CLI_FLAG_REGISTRY[argv[1]]!.includes(flag)) unknown.push(`${code}: gbrain ${argv[1]} ${flag}`);
    }
  }
  expect(unknown).toEqual([]);
});

test('a retired code renders superseded: its fix is read-only, needs no consent, and its suggestion is a plain rerun', () => {
  const retired = entries(CODES).filter(([, entry]) => entry.retired_in);
  expect(retired.map(([code]) => code)).toContain('knock_on_exhausted');
  for (const [, entry] of retired) {
    expect(entry.summary).toMatch(/^Retired:/);
    expect(entry.fix).toMatchObject({ consent: [], requires_exclusive: false });
    expect((entry.fix?.argv ?? []).join(' ')).not.toMatch(/config set|--retry-failed|--reset-checkpoint/);
  }
  expect(CODES.knock_on_exhausted.suggestion).toContain('gbrain sync --source <id> --no-pull');
});

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
});

test('no source line outside the key table and the historical notices names a retired config key', () => {
  // The table defines them; behavior-change-notice keeps the rows older brains are shown on upgrade.
  const allowed = new Set(['src/core/sync-config-keys.ts', 'src/core/behavior-change-notice.ts']);
  const named: string[] = [];
  for (const file of sourceFiles('src').filter(path => !allowed.has(path))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      // A typed lookup of the retired key's replacement (sync-holds.ts) names the key as data, never as advice.
      const text = line.replace(/\b(?:retiredSyncSetting|number)\('sync\.[a-z_]+'/g, '');
      for (const key of RETIRED_KEYS) if (new RegExp(`\\b${key.replace('.', '\\.')}\\b`).test(text)) named.push(`${file}:${i + 1} names ${key}`);
    });
  }
  expect(named).toEqual([]);
});

test('sync and config help name no retired key and no rollback key', async () => {
  const captured: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { captured.push(parts.join(' ')); };
  try {
    (await import('../src/commands/sync/args.ts')).printSyncHelp();
    (await import('../src/commands/config.ts')).printUsage();
  } finally { console.log = log; }
  const help = captured.join('\n');
  expect(help).toContain('--no-bulk');
  const named = [...RETIRED_KEYS, ...SYNC_ROLLBACK_KEYS].filter(key => new RegExp(`\\b${key.replace('.', '\\.')}\\b`).test(help));
  expect(named).toEqual([]);
});

/** #6712 PR 3 (L7): a source line that tells a Git sync to pass the deprecated alias. */
const RETRY_FAILED_ADVICE = /\bgbrain sync\b[^'"`]*--retry-failed/;
// The flag's parse and its deprecation notice; the historical notices; connector sources, where the flag still re-approves a failed item receipt.
const RETRY_FAILED_ALLOWED = new Set(['src/commands/sync/args.ts', 'src/core/sync-flags.ts', 'src/core/behavior-change-notice.ts', 'src/core/persistence/connector-sync.ts',
  'src/core/cli-flag-registry.generated.ts']);

test('no registered fix, fault reason or source line tells a sync to pass the deprecated --retry-failed', () => {
  const texts: Array<[string, string]> = [
    ...entries(CODES).map(([code, entry]) => [`CODES.${code}`, fixText(entry)] as [string, string]),
    ...entries(NOTICE_CODES).filter(([code]) => code !== 'sync_retry_failed_deprecated').map(([code, entry]) => [`NOTICE_CODES.${code}`, fixText(entry)] as [string, string]),
    ...SYNC_FAULT_TABLE.map(rule => [`SYNC_FAULT_TABLE.${rule.code}`, `${rule.human_reason ?? ''}\n${rule.escalate}`] as [string, string]),
  ];
  const named = texts.filter(([, text]) => /sync[^\n]*--retry-failed/.test(text) || text.includes("'sync', '--retry-failed'")).map(([where]) => where);
  for (const [code, entry] of [...entries(CODES), ...entries(NOTICE_CODES)]) {
    const argv = entry.fix?.argv ?? [];
    if (argv[1] === 'sync' && argv.includes('--retry-failed')) named.push(`${code}.fix.argv`);
  }
  for (const file of sourceFiles('src').filter(path => !RETRY_FAILED_ALLOWED.has(path))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      if (RETRY_FAILED_ADVICE.test(line) && !line.includes('sync_retry_failed_deprecated:')) named.push(`${file}:${i + 1}`);
    });
  }
  expect(named).toEqual([]);
});

test('sync --help mentions --retry-failed only as its own deprecated entry', async () => {
  const captured: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { captured.push(parts.join(' ')); };
  try { (await import('../src/commands/sync/args.ts')).printSyncHelp(); } finally { console.log = log; }
  const lines = captured.join('\n').split('\n');
  const mentions = lines.map((line, i) => [line, i] as const).filter(([line]) => line.includes('--retry-failed'));
  expect(mentions.map(([line]) => line.trim().split(/\s+/)[0])).toEqual(['--retry-failed']);
  expect(mentions[0]![0]).toContain('Deprecated');
});

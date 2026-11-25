/**
 * Onboarding roadmap PR 1: gbrain setup's history import, end to end through the CLI (src/commands/setup-history.ts
 * driving 'gbrain transcripts archive setup-import' children). Synthetic sessions only; HOME and GBRAIN_HOME are a
 * temp box, so no real harness folder is read.
 *
 * Authoring gate:
 *  1. Protects: a new install imports nothing until someone says yes; the off-terminal offer is a decision whose
 *     accept command imports exactly the newest session, then offers the 30-day range as its own decision; a lost
 *     reply replayed imports nothing twice; --history none skips; --history N imports at once with real card counts;
 *     a brain setup did not create is refused; conflicting flags exit 2 before anything is written; at a terminal,
 *     a blank answer, end of input or silence never authorizes the range.
 *  2. Fails on: an import without a yes; a range imported on the first answer; a second import from a replayed id;
 *     an existing brain imported into; a conflicting flag that writes a brain; Enter or EOF taken as yes to Q2.
 *  3. Backends: PGLite (setup's keyless default brain), repo-less.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { codingPersona } from './helpers/setup-history-fixtures.ts';
import { historyAnswer, historyFor, parseHistoryFlags } from '../src/commands/setup-history.ts';
import { __testing } from '../src/commands/setup.ts';
import { withEnv } from './helpers/with-env.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string; sessions: string }
function box(persona = true): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-history-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, '#!/bin/sh\nexec \'' + process.execPath + '\' --no-env-file \'' + CLI + '\' "$@"\n');
  chmodSync(bin, 0o755);
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  if (persona) codingPersona(sessions, new Date());
  return { root, home, bin, sessions };
}
const CLEAN = { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
const envOf = (b: Box) => ({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home });
async function setup(b: Box, args: string[]) {
  const r = await runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env: envOf(b), timeoutMs: 180_000 });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
async function card(b: Box) {
  const r = await runCli(['transcripts', 'archive', 'setup-import', 'card', '--harness', 'claude-code', '--json'], { env: envOf(b) });
  return JSON.parse(r.stdout);
}
const conversations = async (b: Box) => (await card(b)).rows.find((r: { key: string }) => r.key === 'conversations').value as number;
const decisionOf = (doc: any) => doc.notices.find((n: any) => n.code === 'first_run_decisions')?.decisions?.find((d: any) => d.id === 'setup_history');

describe('gbrain setup offers the history import on a new install', () => {
  test('off a terminal: nothing imports until the decision is answered; the newest session first, then the range; a replayed reply imports nothing twice', async () => {
    const b = box();
    const first = await setup(b, ['claude-code', '--history-dir', b.sessions]);
    expect(first.exitCode).toBe(0);
    expect(first.doc.history).toMatchObject({ version: 1, status: 'offered', sessions_found: 10, sessions_imported: 0, stages: [], decision: { stage: 'latest', sessions: 1 } });
    expect(await conversations(b)).toBe(0);
    const offer = decisionOf(first.doc);
    expect(offer.options.map((o: any) => o.id)).toEqual(['import', 'decline', 'later']);
    expect(offer.default).toBe('later');
    const ids = first.doc.notices.find((n: any) => n.code === 'first_run_decisions').decisions.map((d: any) => d.id);
    expect(ids.indexOf('setup_history')).toBeGreaterThan(ids.indexOf('brain_shape'));
    const accept = offer.options[0].argv as string[];
    expect(accept.slice(0, 4)).toEqual(['gbrain', 'setup', 'claude-code', '--history-decision']);

    const second = await setup(b, accept.slice(2));
    expect(second.exitCode).toBe(0);
    expect(second.doc.history).toMatchObject({ status: 'imported', sessions_imported: 1, stages: [{ stage: 'latest', status: 'imported' }], decision: { stage: 'range', sessions: 10 } });
    expect(second.doc.history.card.rows.find((r: any) => r.key === 'conversations')).toMatchObject({ value: 1, status: 'measured' });
    expect(await conversations(b)).toBe(1);

    const rangeAccept = decisionOf(second.doc).options[0].argv as string[];
    const third = await setup(b, rangeAccept.slice(2));
    expect(third.doc.history).toMatchObject({ status: 'imported', sessions_imported: 10, stages: [{ stage: 'range' }], decision: null });
    expect(await conversations(b)).toBe(10);

    const replay = await setup(b, rangeAccept.slice(2));
    expect(replay.exitCode).toBe(0);
    expect(replay.doc.history).toMatchObject({ status: 'consumed', stages: [{ stage: 'range', status: 'consumed', days_written: 0 }] });
    expect(await conversations(b)).toBe(10);
  }, 600_000);

  test('--history 30 imports at once and the JSON carries the card with real counts; --history none skips', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--history', '30', '--history-dir', b.sessions]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.history).toMatchObject({ version: 1, status: 'imported', sessions_imported: 10, no_history: false, decision: null, exit: 0, stages: [{ stage: 'range', status: 'imported' }] });
    expect(r.doc.history.lines).toBeUndefined();
    expect(r.doc.history.card.rows.find((x: any) => x.key === 'conversations')).toMatchObject({ value: 10, status: 'measured', by_harness: { 'claude-code': 5, codex: 5 } });
    expect(r.doc.history.card.questions).toHaveLength(3);

    const skip = box();
    const s = await setup(skip, ['codex', '--history', 'none']);
    expect(s.exitCode).toBe(0);
    expect(s.doc.history).toMatchObject({ status: 'skipped', reason: 'history_none', sessions_imported: 0 });
    expect(decisionOf(s.doc)).toBeUndefined();
  }, 600_000);

  test('no sessions on the machine: the card says so instead of offering', async () => {
    const b = box(false);
    const r = await setup(b, ['claude-code', '--history-dir', b.sessions]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.history).toMatchObject({ status: 'nothing_found', sessions_found: 0, no_history: true, decision: null });
    expect(r.doc.history.card.lines[0]).toContain('no Claude Code, Codex or OpenClaw session');
  }, 300_000);

  test('a brain setup did not create is never imported into, even when asked', async () => {
    const b = box();
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: envOf(b) });
    expect(init.exitCode).toBe(0);
    const r = await setup(b, ['claude-code', '--history', '30', '--history-dir', b.sessions]);
    expect(r.exitCode).toBe(1);
    expect(r.doc.history).toMatchObject({ status: 'failed', error: { code: 'setup_history_ineligible' }, sessions_imported: 0 });
    expect(await conversations(b)).toBe(0);
    const quiet = await setup(b, ['claude-code', '--history-dir', b.sessions]);
    expect(quiet.doc.history).toBeUndefined();
  }, 300_000);

  test('the printed commands keep this run\'s wiring choices and quote paths', async () => {
    const b = box(false);
    const spaced = join(b.root, 'agent sessions');
    codingPersona(spaced, new Date());
    const run = async (args: string[]) => {
      const r = await runCli(['setup', ...args, '--gbrain-bin', b.bin], { env: envOf(b), timeoutMs: 180_000 });
      let doc: any = null;
      try { doc = JSON.parse(r.stdout); } catch { doc = null; }
      return { ...r, doc };
    };
    const first = await run(['claude-code', '--no-hooks', '--history-dir', spaced, '--json']);
    expect(first.exitCode).toBe(0);
    expect(first.doc.history).toMatchObject({ status: 'offered', sessions_found: 10, decision: { stage: 'latest' } });
    const { accept_argv, decline_argv } = first.doc.history.decision;
    for (const argv of [accept_argv, decline_argv]) {
      expect(argv).toContain('--no-hooks');
      expect(argv.slice(argv.indexOf('--gbrain-bin'), argv.indexOf('--gbrain-bin') + 2)).toEqual(['--gbrain-bin', b.bin]);
    }
    expect(accept_argv.slice(accept_argv.indexOf('--history-dir'), accept_argv.indexOf('--history-dir') + 2)).toEqual(['--history-dir', spaced]);
    const settings = join(b.home, '.claude', 'settings.json');
    const hooked = () => existsSync(settings) && readFileSync(settings, 'utf8').includes('gbrain');
    expect(hooked()).toBe(false);
    const second = await run([...accept_argv.slice(2), '--json']);
    expect(second.exitCode).toBe(0);
    expect(second.doc.history).toMatchObject({ status: 'imported', sessions_imported: 1 });
    expect(hooked()).toBe(false);

    const text = box(false);
    const textSessions = join(text.root, 'agent sessions');
    codingPersona(textSessions, new Date());
    const r = await runCli(['setup', 'codex', '--history-dir', textSessions, '--gbrain-bin', text.bin], { env: envOf(text), timeoutMs: 180_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--history-dir '" + textSessions + "'");
  }, 600_000);

  test('the printed commands carry a pinned --source and --no-stdio-member, so re-running one keeps the same wiring', () => {
    const f = __testing.parseFlags(['claude-code', '--source', 'work-example', '--no-stdio-member', '--no-hooks']);
    if (typeof f === 'string') throw new Error(f);
    const choices = __testing.setupChoices(f);
    expect(choices.slice(choices.indexOf('--source'), choices.indexOf('--source') + 2)).toEqual(['--source', 'work-example']);
    expect(choices).toContain('--no-stdio-member');
    const plain = __testing.parseFlags(['codex']);
    if (typeof plain === 'string') throw new Error(plain);
    expect(__testing.setupChoices(plain)).toEqual([]);
  });

  test('the deferred command printed while a server holds the brain keeps --history-dir and --no-extract', async () => {
    const dir = join(tmpdir(), 'agent sessions');
    for (const flags of [{ history: 'latest' as const, historyDir: dir, noExtract: true }, { historyDecision: 'dec-example', historyDir: dir, noExtract: true }]) {
      const o = await historyFor({ harness: 'codex', launcher: '/bin/false', flags, brainCreate: true, json: true, liveServe: true, setupArgv: ['gbrain', 'setup', 'codex'], choices: ['--no-hooks'] });
      expect(o).toMatchObject({ status: 'deferred', reason: 'live_serve' });
      expect(o!.lines[0]).toContain("--history-dir '" + dir + "' --no-extract --no-hooks");
    }
  });

  test('every setup-import child is pinned to the host brain setup created, never to a mounted project\'s brain', async () => {
    const b = box(false);
    const log = join(b.root, 'argv.log');
    const fake = join(b.root, 'bin', 'fake-gbrain');
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> \'' + log + '\'\ncase "$*" in *" preview "*) echo \'{"found":{"sessions":0},"answered":[],"harnesses":[]}\' ;; *) echo \'{"lines":[],"no_history":true}\' ;; esac\n');
    chmodSync(fake, 0o755);
    const o = await historyFor({ harness: 'codex', launcher: fake, flags: {}, brainCreate: true, json: true, liveServe: false, setupArgv: ['gbrain', 'setup', 'codex'], interactive: false });
    expect(o).toMatchObject({ status: 'nothing_found' });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.startsWith('--brain host transcripts archive setup-import ')).toBe(true);
  }, 60_000);

  test('conflicting history flags exit 2 before anything is written', async () => {
    const cases = [
      ['claude-code', '--history-decision', 'abcdef12', '--history', 'latest'],
      ['claude-code', '--history', 'none', '--history-dir', '/tmp'],
      ['claude-code', '--history', '31'],
      ['claude-code', '--history', 'latest', '--remove'],
      ['claude-code', '--history', 'latest', '--instructions-only'],
      ['codex', '--history', 'latest', '--serves', 'several', '--members', 'alice-example,bob-example'],
      ['claude-code', '--history', 'latest', '--shape', 'company', '--team'],
      ['claude-code', '--history-dir', 'relative/dir'],
    ];
    for (const args of cases) {
      const b = box(false);
      const r = await setup(b, args);
      expect({ args, code: r.exitCode }).toEqual({ args, code: 2 });
      expect({ args, brain: existsSync(join(b.home, '.gbrain')) }).toEqual({ args, brain: false });
    }
  }, 300_000);
});

describe('answers at a terminal', () => {
  test('Q1 takes Enter as yes; Q2 needs an explicit y; end of input and silence never say yes', () => {
    const line = (text: string) => ({ kind: 'line' as const, text });
    expect(historyAnswer(line(''), true)).toBe('yes');
    expect(historyAnswer(line('Y'), true)).toBe('yes');
    expect(historyAnswer(line('n'), true)).toBe('no');
    expect(historyAnswer({ kind: 'eof' }, true)).toBe('unanswered');
    expect(historyAnswer({ kind: 'timeout' }, true)).toBe('unanswered');
    expect(historyAnswer(line(''), false)).toBe('unanswered');
    expect(historyAnswer({ kind: 'eof' }, false)).toBe('unanswered');
    expect(historyAnswer({ kind: 'timeout' }, false)).toBe('unanswered');
    expect(historyAnswer(line('sure, go ahead'), false)).toBe('unanswered');
    expect(historyAnswer(line('yes'), false)).toBe('yes');
    expect(historyAnswer(line('no'), false)).toBe('no');
  });

  test('a yes to Q1 imports the newest session; a blank or ended answer to Q2 imports nothing more and leaves the offer open; n records a no', async () => {
    for (const q2 of [{ kind: 'line', text: '' }, { kind: 'eof' }, { kind: 'timeout' }, { kind: 'line', text: 'n' }] as const) {
      const b = box();
      expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: envOf(b) })).exitCode).toBe(0);
      expect((await runCli(['transcripts', 'archive', 'setup-import', 'receipt', '--harness', 'claude-code', '--created-by-setup', '--json'], { env: envOf(b) })).exitCode).toBe(0);
      const answers = [{ kind: 'line', text: '' }, q2];
      const prompts: string[] = [];
      const out = await withEnv(envOf(b), () => historyFor({
        harness: 'claude-code', launcher: b.bin, flags: { historyDir: b.sessions }, brainCreate: true, json: false, liveServe: false, interactive: true,
        setupArgv: ['gbrain', 'setup', 'claude-code'], read: (async (o: { prompt: string }) => { prompts.push(o.prompt); return answers.shift(); }) as never,
      }));
      expect(prompts[0]).toContain('[Y/n]');
      expect(prompts[1]).toContain('[y/N]');
      expect(out).toMatchObject({ status: 'imported', sessions_imported: 1, stages: [{ stage: 'latest' }] });
      expect(await conversations(b)).toBe(1);
      if (q2.kind === 'line' && q2.text === 'n') {
        expect(out!.decision).toBeNull();
        const receipt = JSON.parse((await runCli(['config', 'get', 'onboarding.install_receipt'], { env: envOf(b) })).stdout.trim());
        expect(receipt.declined.range).toBeTruthy();
      } else expect(out!.decision).toMatchObject({ stage: 'range' });
    }
  }, 600_000);
});

describe('the work budget', () => {
  test('time spent waiting for an answer does not count against the 20 s work budget', async () => {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: envOf(b) })).exitCode).toBe(0);
    expect((await runCli(['transcripts', 'archive', 'setup-import', 'receipt', '--harness', 'codex', '--created-by-setup', '--json'], { env: envOf(b) })).exitCode).toBe(0);
    const slow = (async () => { await new Promise(r => setTimeout(r, 13_000)); return { kind: 'line', text: '' }; }) as never;
    const out = await withEnv(envOf(b), () => historyFor({ harness: 'codex', launcher: b.bin, flags: { historyDir: b.sessions }, brainCreate: true, json: false, liveServe: false,
      interactive: true, budgetMs: 12_000, setupArgv: ['gbrain', 'setup', 'codex'], read: slow }));
    expect(out).toMatchObject({ status: 'imported', sessions_imported: 1, stages: [{ stage: 'latest', status: 'imported' }] });
    expect((out!.card as any).rows.find((r: any) => r.key === 'conversations').value).toBe(1);
  }, 300_000);
});

describe('flag parsing', () => {
  const p = (args: string[]) => parseHistoryFlags(args, f => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1] ?? ''; }, args[0]);
  test('values', () => {
    expect(p(['claude-code'])).toEqual({});
    expect(p(['claude-code', '--history', '7', '--no-extract'])).toEqual({ history: 7, noExtract: true });
    expect(p(['codex', '--history', 'latest', '--history-dir', '/x'])).toEqual({ history: 'latest', historyDir: '/x' });
    expect(p(['codex', '--history-decision', '9cf7e43d-1472'])).toEqual({ historyDecision: '9cf7e43d-1472' });
    expect(typeof p(['openclaw', '--history', 'latest'])).toBe('string');
    expect(typeof p(['claude-code', '--history', '0'])).toBe('string');
  });
});

/**
 * Tests for src/core/bootstrap/interview.ts — the bootstrap interview engine.
 *
 * Pins the plan's interview hardening (docs/designs/AGENT_BOOTSTRAP_PLAN.md):
 *  - required-key gate data (status → missingRequired/complete)
 *  - skip refuses required keys
 *  - [G10] maxLength / rejectValues / allowed enforcement, control-char
 *    stripping, `{{`/`}}` set-time escaping
 *  - [G12] conflict-marker + invalid-JSON detection returns typed errors,
 *    never throws
 *  - [A8] confirm requires the hash of the exact set that was read back;
 *    single-batch set+confirm-without-readback fails; set_at provenance
 *  - [CX2-13] PROVIDER_KEY (persist:false, sink:'config') never lands in
 *    interview.json and never leaks through results or error messages
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initState,
  interviewStatePath,
  readInterviewState,
  setAnswer,
  skipAnswer,
  status,
  readBackHash,
  confirm,
  show,
  sanitizeAnswerValue,
  routeProviderKeyToConfig,
} from '../src/core/bootstrap/interview.ts';
import { configPath } from '../src/core/config.ts';

const REQUIRED = [
  'AGENT_NAME',
  'PRINCIPAL_NAME',
  'AGENT_PURPOSE',
  'AGENT_TOP_JOBS',
  'PRINCIPAL_CONTEXT',
  'VOICE_REGISTER',
] as const;

const ANSWERS: Record<(typeof REQUIRED)[number], string> = {
  AGENT_NAME: 'Trenton',
  PRINCIPAL_NAME: 'Alice Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research lab; ships a memo every Friday.',
  VOICE_REGISTER: 'Direct. Three options, the second one wins.',
};

function makeWs(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-interview-test-'));
}

function answerAllRequired(ws: string): void {
  for (const key of REQUIRED) {
    const r = setAnswer(ws, key, ANSWERS[key]);
    expect(r.ok).toBe(true);
  }
}

function expectErr(r: { ok: boolean }, code: string): asserts r is { ok: false; code: string; message: string } {
  expect(r.ok).toBe(false);
  expect((r as unknown as { code: string }).code).toBe(code);
}

describe('initState + readInterviewState', () => {
  test('creates state/interview.json once, idempotently', () => {
    const ws = makeWs();
    const first = initState(ws);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.created).toBe(true);
    const second = initState(ws);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.created).toBe(false);
    const parsed = JSON.parse(readFileSync(interviewStatePath(ws), 'utf8'));
    expect(parsed).toEqual({ version: 1, answers: {} });
  });

  test('missing file reads as a fresh empty state (exists: false)', () => {
    const ws = makeWs();
    const read = readInterviewState(ws);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.exists).toBe(false);
      expect(read.state.answers).toEqual({});
    }
  });

  test('[G12] git conflict markers → typed error with agent-readable message, no throw', () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'state'), { recursive: true });
    writeFileSync(
      interviewStatePath(ws),
      '<<<<<<< HEAD\n{"version":1,"answers":{}}\n=======\n{"version":1}\n>>>>>>> other\n'
    );
    const read = readInterviewState(ws);
    expectErr(read, 'conflict_markers');
    expect(read.message).toContain('resolve');
    // status and setAnswer surface the same typed error and never clobber.
    expectErr(status(ws), 'conflict_markers');
    expectErr(setAnswer(ws, 'AGENT_NAME', 'Trenton'), 'conflict_markers');
    expect(readFileSync(interviewStatePath(ws), 'utf8')).toContain('<<<<<<<');
  });

  test('[G12] invalid JSON → typed error, never a thrown SyntaxError', () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'state'), { recursive: true });
    writeFileSync(interviewStatePath(ws), 'this is not json');
    const read = readInterviewState(ws);
    expectErr(read, 'invalid_json');
    expect(read.message).toContain('not valid JSON');
  });

  test('newer state version → typed error naming the upgrade path', () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'state'), { recursive: true });
    writeFileSync(interviewStatePath(ws), JSON.stringify({ version: 9, answers: {} }));
    expectErr(readInterviewState(ws), 'newer_version');
  });
});

describe('gate data (status)', () => {
  test('fresh state: all 6 required missing, complete false', () => {
    const ws = makeWs();
    initState(ws);
    const st = status(ws);
    expect(st.ok).toBe(true);
    if (st.ok) {
      expect(st.missingRequired.sort()).toEqual([...REQUIRED].sort());
      expect(st.answered).toEqual([]);
      expect(st.complete).toBe(false);
      expect(st.confirmed).toBe(false);
    }
  });

  test('answering all required flips complete', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    const st = status(ws);
    if (!st.ok) throw new Error(st.message);
    expect(st.missingRequired).toEqual([]);
    expect(st.complete).toBe(true);
    expect(st.answered.sort()).toEqual([...REQUIRED].sort());
  });

  test('a skipped optional key counts as skipped, not answered', () => {
    const ws = makeWs();
    const r = skipAnswer(ws, 'SOUL_WINCE');
    expect(r.ok).toBe(true);
    const st = status(ws);
    if (!st.ok) throw new Error(st.message);
    expect(st.skipped).toEqual(['SOUL_WINCE']);
    expect(st.answered).toEqual([]);
  });
});

describe('skipAnswer', () => {
  test('refuses required keys', () => {
    const ws = makeWs();
    for (const key of REQUIRED) {
      const r = skipAnswer(ws, key);
      expectErr(r, 'required_key');
      expect(r.message).toContain(key);
    }
  });

  test('optional skip persists skipped:true with provenance', () => {
    const ws = makeWs();
    const r = skipAnswer(ws, 'SOUL_WORLDVIEW');
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(interviewStatePath(ws), 'utf8'));
    expect(parsed.answers.SOUL_WORLDVIEW.skipped).toBe(true);
    expect(Number.isNaN(Date.parse(parsed.answers.SOUL_WORLDVIEW.set_at))).toBe(false);
  });
});

describe('[G10] setAnswer enforcement', () => {
  test('unknown key → typed error', () => {
    const ws = makeWs();
    expectErr(setAnswer(ws, 'NOT_A_KEY', 'x'), 'unknown_key');
  });

  test('empty value → typed error suggesting skip', () => {
    const ws = makeWs();
    const r = setAnswer(ws, 'SOUL_WINCE', '   ');
    expectErr(r, 'empty_value');
    expect(r.message).toContain('skip');
  });

  test('maxLength rejected with a clear truncation message', () => {
    const ws = makeWs();
    const r = setAnswer(ws, 'AGENT_NAME', 'a'.repeat(65));
    expectErr(r, 'too_long');
    expect(r.message).toContain('64');
    expect(r.message.toLowerCase()).toContain('truncate');
  });

  test('rejectValues blocks placeholder names, case-insensitively', () => {
    const ws = makeWs();
    for (const bad of ['agent', 'Agent', ' AI ', 'tbd']) {
      expectErr(setAnswer(ws, 'AGENT_NAME', bad), 'rejected_value');
    }
    expect(setAnswer(ws, 'AGENT_NAME', 'Trenton').ok).toBe(true);
  });

  test('allowed list enforced for consent keys; canonical spelling stored', () => {
    const ws = makeWs();
    expectErr(setAnswer(ws, 'SEARCH_MODE', 'warp-speed'), 'not_allowed');
    const r = setAnswer(ws, 'SEARCH_MODE', 'BALANCED');
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(interviewStatePath(ws), 'utf8'));
    expect(parsed.answers.SEARCH_MODE.value).toBe('balanced');
  });

  test('control characters stripped; CRLF normalized to LF', () => {
    expect(sanitizeAnswerValue('hello\x07world\r\nnext\tkeep')).toBe('helloworld\nnext\tkeep');
  });

  test('{{ and }} escaped at set time — token regex can never match the stored value', () => {
    const ws = makeWs();
    const r = setAnswer(ws, 'VOICE_REGISTER', 'I use {{handlebars}} and {{{RUNS}}} daily');
    expect(r.ok).toBe(true);
    if (r.ok && r.sink === 'state') {
      expect(r.value).not.toContain('{{');
      expect(r.value).not.toContain('}}');
      expect(r.value).toContain('{ {');
    }
    const raw = readFileSync(interviewStatePath(ws), 'utf8');
    const stored = JSON.parse(raw).answers.VOICE_REGISTER.value as string;
    expect(/\{\{/.test(stored)).toBe(false);
    expect(/\}\}/.test(stored)).toBe(false);
  });

  test('brace runs converge (no adjacent pair survives repeated escaping)', () => {
    const v = sanitizeAnswerValue('{{{{X}}}}');
    expect(v).not.toContain('{{');
    expect(v).not.toContain('}}');
  });
});

describe('[A8] provenance + read-back confirm', () => {
  test('every answer records a parseable set_at ISO timestamp', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    const parsed = JSON.parse(readFileSync(interviewStatePath(ws), 'utf8'));
    for (const key of REQUIRED) {
      const setAt = parsed.answers[key].set_at as string;
      expect(Number.isNaN(Date.parse(setAt))).toBe(false);
      expect(new Date(setAt).toISOString()).toBe(setAt);
    }
  });

  test('readBackHash refuses an incomplete required set', () => {
    const ws = makeWs();
    setAnswer(ws, 'AGENT_NAME', 'Trenton');
    const r = readBackHash(ws);
    expectErr(r, 'incomplete');
    expect(r.message).toContain('PRINCIPAL_NAME');
  });

  test('confirm with a wrong hash fails; with the current hash succeeds', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    expectErr(confirm(ws, 'deadbeef'), 'hash_mismatch');
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    const c = confirm(ws, h.hash);
    expect(c.ok).toBe(true);
    const st = status(ws);
    if (!st.ok) throw new Error(st.message);
    expect(st.confirmed).toBe(true);
  });

  test('HOSTILE: single-batch set+confirm without a fresh read-back fails', () => {
    const ws = makeWs();
    // The agent sets five answers, grabs a hash mid-stream, then sets the
    // sixth and confirms with the stale hash — the human never saw the final
    // set. Must fail.
    for (const key of REQUIRED.slice(0, 5)) setAnswer(ws, key, ANSWERS[key]);
    setAnswer(ws, 'SOUL_WINCE', 'Filler openers.');
    // Not even computable pre-completion for the required set — but simulate
    // the closest attack: complete the set, hash, then change an answer.
    setAnswer(ws, REQUIRED[5], ANSWERS[REQUIRED[5]]);
    const stale = readBackHash(ws);
    if (!stale.ok) throw new Error(stale.message);
    setAnswer(ws, 'SOUL_WINCE', 'Actually: hedging.'); // set AFTER the read-back
    expectErr(confirm(ws, stale.hash), 'hash_mismatch');
    // Only the hash of the exact current set — computed AFTER all answers —
    // is accepted.
    const fresh = readBackHash(ws);
    if (!fresh.ok) throw new Error(fresh.message);
    expect(confirm(ws, fresh.hash).ok).toBe(true);
  });

  test('any later setAnswer or skipAnswer invalidates a prior confirm', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    confirm(ws, h.hash);
    setAnswer(ws, 'SOUL_GOOD_OUTPUT', 'A finished artifact.');
    const st = status(ws);
    if (!st.ok) throw new Error(st.message);
    expect(st.confirmed).toBe(false);
    const parsed = JSON.parse(readFileSync(interviewStatePath(ws), 'utf8'));
    expect(parsed.confirmed).toBeUndefined();
  });

  test('setAnswer surfaces invalidatedConfirmation ONLY when a confirm existed', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    // No prior confirmation → nothing was invalidated (falsy flag).
    const r0 = setAnswer(ws, 'SOUL_WINCE', 'Filler openers.');
    expect(r0.ok).toBe(true);
    if (!r0.ok || r0.sink !== 'state') throw new Error('expected a state-sink result');
    expect(r0.invalidatedConfirmation).toBeFalsy();
    // Full confirm, then a later set → the result SAYS it voided the confirm
    // (the CLI warns at --set time instead of failing much later at render).
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    expect(confirm(ws, h.hash).ok).toBe(true);
    const r1 = setAnswer(ws, 'SOUL_GOOD_OUTPUT', 'A finished artifact.');
    expect(r1.ok).toBe(true);
    if (!r1.ok || r1.sink !== 'state') throw new Error('expected a state-sink result');
    expect(r1.invalidatedConfirmation).toBe(true);
    const st = status(ws);
    if (!st.ok) throw new Error(st.message);
    expect(st.confirmed).toBe(false);
  });

  test('skipAnswer surfaces invalidatedConfirmation ONLY when a confirm existed (optional key — required keys refuse skip)', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    // No prior confirmation → falsy flag on an optional-key skip.
    const r0 = skipAnswer(ws, 'SOUL_WINCE');
    expect(r0.ok).toBe(true);
    if (!r0.ok) throw new Error('unreachable');
    expect(r0.invalidatedConfirmation).toBeFalsy();
    // Full confirm, then a later optional-key skip → invalidation surfaced.
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    expect(confirm(ws, h.hash).ok).toBe(true);
    const r1 = skipAnswer(ws, 'SOUL_WORLDVIEW');
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error('unreachable');
    expect(r1.invalidatedConfirmation).toBe(true);
    const st = status(ws);
    if (!st.ok) throw new Error(st.message);
    expect(st.confirmed).toBe(false);
  });

  test('show returns the read-back payload with the hash once complete', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    setAnswer(ws, 'SEARCH_MODE', 'balanced');
    const s = show(ws);
    if (!s.ok) throw new Error(s.message);
    expect(s.entries.length).toBe(12); // the 12 interview keys
    const name = s.entries.find((e) => e.key === 'AGENT_NAME');
    expect(name?.value).toBe('Trenton');
    expect(name?.required).toBe(true);
    expect(s.extras.map((e) => e.key)).toEqual(['SEARCH_MODE']);
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    expect(s.hash).toBe(h.hash);
  });
});

describe('[CX2-13] PROVIDER_KEY never lands in interview.json', () => {
  test('setAnswer returns the config sink and persists NOTHING', () => {
    const ws = makeWs();
    setAnswer(ws, 'AGENT_NAME', 'Trenton'); // ensure the state file exists
    const before = readFileSync(interviewStatePath(ws), 'utf8');
    const r = setAnswer(ws, 'PROVIDER_KEY', 'sk-ant-supersecret-123456');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sink).toBe('config');
      expect(r.key).toBe('PROVIDER_KEY');
    }
    // The value appears NOWHERE in the result object.
    expect(JSON.stringify(r)).not.toContain('supersecret');
    // The state file is byte-identical: no PROVIDER_KEY entry, no secret.
    const after = readFileSync(interviewStatePath(ws), 'utf8');
    expect(after).toBe(before);
    expect(after).not.toContain('PROVIDER_KEY');
    expect(after).not.toContain('supersecret');
  });

  test('skip on PROVIDER_KEY persists nothing either', () => {
    const ws = makeWs();
    setAnswer(ws, 'AGENT_NAME', 'Trenton');
    const before = readFileSync(interviewStatePath(ws), 'utf8');
    const r = skipAnswer(ws, 'PROVIDER_KEY');
    expect(r.ok).toBe(true);
    expect(readFileSync(interviewStatePath(ws), 'utf8')).toBe(before);
  });

  test('too-long provider key error never echoes the value', () => {
    const ws = makeWs();
    const secret = `sk-${'a'.repeat(300)}`;
    const r = setAnswer(ws, 'PROVIDER_KEY', secret);
    expectErr(r, 'too_long');
    expect(r.message).not.toContain(secret);
    expect(r.message).not.toContain('aaaa');
  });

  test('PROVIDER_KEY does not participate in the read-back hash', () => {
    const ws = makeWs();
    answerAllRequired(ws);
    const h1 = readBackHash(ws);
    if (!h1.ok) throw new Error(h1.message);
    confirm(ws, h1.hash);
    setAnswer(ws, 'PROVIDER_KEY', 'sk-ant-supersecret-123456');
    const h2 = readBackHash(ws);
    if (!h2.ok) throw new Error(h2.message);
    expect(h2.hash).toBe(h1.hash); // sink answers are hash-invisible
    const st = status(ws);
    if (!st.ok) throw new Error(st.message);
    expect(st.confirmed).toBe(true); // and don't invalidate the confirm
  });
});

describe('routeProviderKeyToConfig (0600 config sink)', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-interview-home-'));
    prevHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function seedConfig(): void {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
  }

  test('routes each provider prefix to its config key, mode 0600', () => {
    seedConfig();
    const cases: Array<[string, string]> = [
      ['sk-ant-abc123', 'anthropic_api_key'],
      ['sk-plainopenai456', 'openai_api_key'],
      ['pa-voyage789', 'voyage_api_key'],
    ];
    for (const [key, configKey] of cases) {
      const r = routeProviderKeyToConfig(key);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.configKey).toBe(configKey as typeof r.configKey);
      const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
      expect(cfg[configKey]).toBe(key);
    }
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  test('unrecognized key shape → error that never echoes the value', () => {
    seedConfig();
    const r = routeProviderKeyToConfig('xoxb-not-a-supported-provider');
    expectErr(r, 'unrecognized_key_shape');
    expect(r.message).not.toContain('xoxb');
  });

  test('missing config → agent-readable "run gbrain init first" error', () => {
    const r = routeProviderKeyToConfig('sk-ant-abc123');
    expectErr(r, 'config_missing');
    expect(r.message).toContain('gbrain init');
    expect(existsSync(configPath())).toBe(false);
  });
});

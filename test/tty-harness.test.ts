/**
 * Unit suite for test/helpers/tty-harness.ts — the PTY DX harness.
 *
 * Pure helpers (stripAnsi, computeStalls, renderStallsReport,
 * parseDriveCommand, buildClaudeTuiSeed, saveTranscript) are exercised with
 * ZERO subprocesses. Two live smokes spawn `sh` under a real PTY (cheap,
 * no network, no API) and skip cleanly on a Bun without `terminal:` support
 * — the same fail-SKIP posture as the agent-harness door tests.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  stripAnsi,
  computeStalls,
  renderStallsReport,
  parseDriveCommand,
  buildClaudeTuiSeed,
  saveTranscript,
  redactSecrets,
  coalesceSecretStraddles,
  launchTty,
  ptySupported,
  KEY_MAP,
  type PtyFrame,
} from './helpers/tty-harness.ts';

describe('stripAnsi', () => {
  test('removes CSI color + cursor sequences', () => {
    expect(stripAnsi('\x1b[1;32mgreen\x1b[0m plain \x1b[2K\x1b[1Gline')).toBe('green plain line');
  });

  test('removes OSC title sequences (BEL and ST terminated)', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
    expect(stripAnsi('\x1b]8;;http://x\x1b\\link')).toBe('link');
  });

  test('removes charset selection and keypad modes', () => {
    expect(stripAnsi('\x1b(Bhello\x1b=world\x1b>')).toBe('helloworld');
  });

  test('removes private-mode CSI (cursor hide/show)', () => {
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden');
  });
});

describe('computeStalls', () => {
  const frames: PtyFrame[] = [
    { tMs: 100, data: 'boot\n' },
    { tMs: 300, data: 'fast\n' },
    { tMs: 5300, data: 'after long silence\n' },
    { tMs: 5400, data: 'tail\n' },
  ];

  test('finds mid-run gaps over the threshold with the pre-gap screen as context', () => {
    const stalls = computeStalls(frames, { thresholdMs: 2000 });
    expect(stalls.length).toBe(1);
    expect(stalls[0]!.startMs).toBe(300);
    expect(stalls[0]!.durationMs).toBe(5000);
    expect(stalls[0]!.context).toContain('fast');
  });

  test('counts startup silence (spawn → first byte)', () => {
    const late: PtyFrame[] = [{ tMs: 4000, data: 'finally\n' }];
    const stalls = computeStalls(late, { thresholdMs: 2000 });
    expect(stalls.length).toBe(1);
    expect(stalls[0]!.startMs).toBe(0);
    expect(stalls[0]!.context).toBe('(no output yet)');
  });

  test('counts trailing silence when endMs is supplied', () => {
    const stalls = computeStalls(frames, { thresholdMs: 2000, endMs: 12_000 });
    expect(stalls.length).toBe(2);
    expect(stalls[1]!.startMs).toBe(5400);
    expect(stalls[1]!.durationMs).toBe(6600);
    expect(stalls[1]!.context).toContain('tail');
  });

  test('below-threshold gaps are ignored', () => {
    expect(computeStalls(frames, { thresholdMs: 6000 })).toEqual([]);
  });

  test('empty frames + endMs = one all-silence stall', () => {
    const stalls = computeStalls([], { thresholdMs: 2000, endMs: 3000 });
    expect(stalls.length).toBe(1);
    expect(stalls[0]!.durationMs).toBe(3000);
  });

  test('empty frames without endMs = no stalls', () => {
    expect(computeStalls([], { thresholdMs: 2000 })).toEqual([]);
  });
});

describe('renderStallsReport', () => {
  test('renders duration + context per stall', () => {
    const md = renderStallsReport(
      [{ startMs: 300, durationMs: 5000, context: 'Loading brain…' }],
      10_000,
    );
    expect(md).toContain('5.0s at t+0.3s');
    expect(md).toContain('Loading brain…');
    expect(md).toContain('1 silence window');
  });

  test('clean report when no stalls', () => {
    expect(renderStallsReport([], 4000)).toContain('No stalls at threshold');
  });
});

describe('parseDriveCommand', () => {
  test('parses line / send / key / note / stop', () => {
    expect(parseDriveCommand('{"line":"hello"}')).toEqual({ kind: 'send', data: 'hello\r' });
    expect(parseDriveCommand('{"send":"hello\\r"}')).toEqual({ kind: 'send', data: 'hello\r' });
    expect(parseDriveCommand('{"key":"Enter"}')).toEqual({ kind: 'key', key: 'Enter' });
    expect(parseDriveCommand('{"note":"confusing picker"}')).toEqual({
      kind: 'note',
      text: 'confusing picker',
    });
    expect(parseDriveCommand('{"stop":true}')).toEqual({ kind: 'stop' });
  });

  test('line strips its own trailing newline before appending Enter', () => {
    expect(parseDriveCommand('{"line":"hello\\n"}')).toEqual({ kind: 'send', data: 'hello\r' });
  });

  test('re-escapes raw control bytes that zsh echo produces from \\r', () => {
    // A literal CR byte inside the JSON string (what `echo '{"send":"x\r"}'`
    // yields under zsh) must parse instead of being dropped.
    expect(parseDriveCommand('{"send":"x\r"}')).toEqual({ kind: 'send', data: 'x\r' });
    expect(parseDriveCommand('{"line":"y\r"}')).toEqual({ kind: 'send', data: 'y\r' });
  });

  test('rejects malformed JSON, unknown keys, unknown key names', () => {
    expect(parseDriveCommand('not json')).toBeNull();
    expect(parseDriveCommand('{"frobnicate":1}')).toBeNull();
    expect(parseDriveCommand('{"key":"HyperMeta"}')).toBeNull();
    expect(parseDriveCommand('{"stop":false}')).toBeNull();
    expect(parseDriveCommand('null')).toBeNull();
    expect(parseDriveCommand('"str"')).toBeNull();
  });

  test('every KEY_MAP name round-trips through the key command', () => {
    for (const name of Object.keys(KEY_MAP)) {
      expect(parseDriveCommand(JSON.stringify({ key: name }))).toEqual({ kind: 'key', key: name });
    }
  });
});

describe('buildClaudeTuiSeed', () => {
  test('marks onboarding complete and pre-trusts dirs', () => {
    const seed = buildClaudeTuiSeed({ trustedDirs: ['/tmp/ws-a', '/tmp/ws-b'] });
    expect(seed.hasCompletedOnboarding).toBe(true);
    const projects = seed.projects as Record<string, { hasTrustDialogAccepted: boolean }>;
    expect(projects['/tmp/ws-a']!.hasTrustDialogAccepted).toBe(true);
    expect(projects['/tmp/ws-b']!.hasTrustDialogAccepted).toBe(true);
    expect(seed.customApiKeyResponses).toBeUndefined();
  });

  test('approves the last 20 chars of a provided API key', () => {
    const key = 'sk-ant-' + 'x'.repeat(40);
    const seed = buildClaudeTuiSeed({ apiKey: key, trustedDirs: [] });
    expect(seed.customApiKeyResponses).toEqual({ approved: [key.slice(-20)] });
  });
});

describe('saveTranscript', () => {
  test('writes the full bundle (meta, raw, visible, frames, stalls)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-tty-unit-'));
    try {
      const frames: PtyFrame[] = [
        { tMs: 50, data: '\x1b[32mready\x1b[0m\n' },
        { tMs: 4050, data: 'done\n' },
      ];
      saveTranscript(dir, {
        frames,
        raw: frames.map((f) => f.data).join(''),
        meta: {
          scenario: 'unit',
          argv: ['sh', '-c', 'x'],
          startedAtIso: '2026-08-12T00:00:00.000Z',
          exitCode: 0,
          durationMs: 4100,
        },
      });
      expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).scenario).toBe('unit');
      expect(readFileSync(join(dir, 'visible.txt'), 'utf8')).toBe('ready\ndone\n');
      expect(readFileSync(join(dir, 'raw.txt'), 'utf8')).toContain('\x1b[32m');
      const frameLines = readFileSync(join(dir, 'frames.jsonl'), 'utf8').trim().split('\n');
      expect(frameLines.length).toBe(2);
      expect(readFileSync(join(dir, 'stalls.md'), 'utf8')).toContain('4.0s at t+0.1s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('redact: the raw secret value appears in NO written file, the marker does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-tty-unit-'));
    const secret = 'xai-supersecret-value-1234';
    try {
      const frames: PtyFrame[] = [
        // Secret split across a frame boundary — the joined-string pass
        // still catches it in frames.jsonl's neighbors and in raw/visible.
        { tMs: 10, data: `key is ${secret.slice(0, 10)}` },
        { tMs: 20, data: `${secret.slice(10)} — do not log\n` },
        { tMs: 30, data: `again: ${secret}\n` },
      ];
      saveTranscript(dir, {
        frames,
        raw: frames.map((f) => f.data).join(''),
        meta: {
          scenario: 'unit-redact',
          argv: ['sh'],
          startedAtIso: '2026-08-14T00:00:00.000Z',
          exitCode: 0,
          durationMs: 100,
        },
        redact: { XAI_API_KEY: secret, EMPTY: '', SHORT: 'abc' },
      });
      for (const f of ['meta.json', 'raw.txt', 'visible.txt', 'frames.jsonl', 'stalls.md']) {
        expect(readFileSync(join(dir, f), 'utf8')).not.toContain(secret);
      }
      // The REAL frames assertion: a per-record grep is vacuous for a secret
      // split across frame boundaries (each half is innocent) — join the data
      // fields and assert the reassembled stream carries no secret. This is
      // what coalesceSecretStraddles guarantees.
      const joined = readFileSync(join(dir, 'frames.jsonl'), 'utf8')
        .trim().split('\n')
        .map((l) => (JSON.parse(l) as { data: string }).data)
        .join('');
      expect(joined).not.toContain(secret);
      expect(joined).toContain('[REDACTED:XAI_API_KEY]');
      expect(readFileSync(join(dir, 'raw.txt'), 'utf8')).toContain('[REDACTED:XAI_API_KEY]');
      expect(readFileSync(join(dir, 'visible.txt'), 'utf8')).toContain('[REDACTED:XAI_API_KEY]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('redactSecrets is pure and skips empty/too-short values', () => {
    expect(redactSecrets('hello world', undefined)).toBe('hello world');
    expect(redactSecrets('abc abc', { K: 'abc' })).toBe('abc abc'); // <8 chars: skipped
    expect(redactSecrets('token=longsecret42 end', { K: 'longsecret42' })).toBe('token=[REDACTED:K] end');
  });

  test('coalesceSecretStraddles merges only the frames a secret spans', () => {
    const secret = 'straddling-secret-99';
    const frames: PtyFrame[] = [
      { tMs: 1, data: 'before ' },
      { tMs: 2, data: `x${secret.slice(0, 7)}` },
      { tMs: 3, data: secret.slice(7, 14) },
      { tMs: 4, data: `${secret.slice(14)} after` },
      { tMs: 5, data: 'untouched' },
    ];
    const out = coalesceSecretStraddles(frames, { K: secret });
    expect(out.length).toBe(3); // frames 2-4 merged; 1 and 5 intact
    expect(out[0]!.data).toBe('before ');
    expect(out[1]!.data).toContain(secret); // contiguous now — redactable
    expect(out[2]!.data).toBe('untouched');
    // No secrets → identity (new array, same content).
    const same = coalesceSecretStraddles(frames, {});
    expect(same.map((f) => f.data)).toEqual(frames.map((f) => f.data));
  });
});

describe.skipIf(!ptySupported())('launchTty (live PTY smoke)', () => {
  test('captures timestamped frames from a real PTY child', async () => {
    const session = launchTty(['sh', '-c', 'printf one; sleep 0.6; printf two'], {
      timeoutMs: 15_000,
    });
    const code = await session.waitForExit(10_000);
    await session.close();
    expect(code).toBe(0);
    expect(session.visible()).toContain('one');
    expect(session.visible()).toContain('two');
    const frames = session.frames();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    // The 600ms sleep shows up as a measurable gap (loose bound: >= 300ms).
    // Match the specific stall rather than index 0 — a slow spawn on a loaded
    // CI box can prepend a startup stall ('(no output yet)') before it.
    const stalls = computeStalls(frames, { thresholdMs: 300 });
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls.some((s) => s.context.includes('one'))).toBe(true);
  }, 20_000);

  test('send + waitFor drive an interactive child; child sees a real TTY', async () => {
    // Assert TTY-ness via `[ -t 0 ]` + a sentinel, NOT by matching the tty(1)
    // device path — macOS PTYs are /dev/ttysNNN but Linux CI PTYs are
    // /dev/pts/N, so a /dev\/tty pattern is a portability trap (bit us on CI).
    const session = launchTty(['sh', '-c', '[ -t 0 ] && echo IS_TTY || echo NOT_TTY; read line; echo "got:$line"'], {
      timeoutMs: 15_000,
    });
    await session.waitFor('IS_TTY', { timeoutMs: 8000 });
    session.send('ping\r');
    await session.waitFor('got:ping', { timeoutMs: 8000 });
    await session.waitForExit(5000);
    await session.close();
    expect(session.exited()).toBe(true);
    expect(session.visible()).not.toContain('NOT_TTY');
  }, 20_000);

  test('waitForQuiet settles after output stops and reports exit as quiet', async () => {
    const session = launchTty(['sh', '-c', 'printf a; sleep 0.2; printf b'], {
      timeoutMs: 15_000,
    });
    const quiet = await session.waitForQuiet({ quietMs: 500, timeoutMs: 10_000 });
    expect(quiet).toBe(true);
    await session.close();
  }, 20_000);
});

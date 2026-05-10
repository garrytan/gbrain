/**
 * Tests for the restart-sweep recipe's inlined script.
 *
 * The script lives inside `recipes/restart-sweep.md` as a fenced
 * `javascript` block, anchored on a sentinel HTML comment
 * (`<!-- restart-sweep:script -->`). loadDetector() extracts the
 * block, salts the tmp filename to bypass the ESM import cache, and
 * dynamic-imports for fresh construction per call.
 *
 * Test isolation: every env mutation routes through `withEnv` from
 * `test/helpers/with-env.ts` per the project's R1 lint rule. State-
 * file tests scope `GBRAIN_HOME` to a per-test tmpdir so they don't
 * touch the developer's real `~/.gbrain/`.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';

const RECIPE_PATH = join(import.meta.dir, '../recipes/restart-sweep.md');

/**
 * Sentinel-anchored extractor (C6). Future doc edits adding example
 * blocks above the script can't redirect what's tested.
 */
async function loadDetector(): Promise<any> {
  const md = readFileSync(RECIPE_PATH, 'utf8');
  const m = md.match(
    /<!--\s*restart-sweep:script\s*-->\s*\n```javascript\s*\n([\s\S]+?)\n```/,
  );
  if (!m) {
    throw new Error(
      'Sentinel <!-- restart-sweep:script --> + fenced javascript block not found in recipe. ' +
        'Did you remove the sentinel from recipes/restart-sweep.md?',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'restart-sweep-test-'));
  // Salt filename per call so ESM cache returns fresh module — required for
  // the constructor-time env tests where each construction needs to see the
  // env mutation we just made.
  const filename = `restart-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`;
  const path = join(dir, filename);
  writeFileSync(path, m[1]);
  const mod = await import(path);
  return mod.default;
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'restart-sweep-state-'));
}

// ─── Sentinel + recipe-shape guards ───────────────────────────────────

test('recipe contains the C6 sentinel before the fenced javascript block', () => {
  const md = readFileSync(RECIPE_PATH, 'utf8');
  expect(md).toContain('<!-- restart-sweep:script -->');
  // Sentinel must precede the fenced block, not follow it
  const sentinelIdx = md.indexOf('<!-- restart-sweep:script -->');
  const fenceIdx = md.indexOf('```javascript', sentinelIdx);
  expect(fenceIdx).toBeGreaterThan(sentinelIdx);
  // ...and within ~50 chars (a single line of slack)
  expect(fenceIdx - sentinelIdx).toBeLessThan(50);
});

// ─── 1-3: Constructor mode resolution (ported, but C2-strengthened) ────

describe('determineAlertMode', () => {
  test('returns "telegram" when both group and topic are configured', async () => {
    await withEnv(
      {
        OPENCLAW_OWNER_IDS: '1,2',
        OPENCLAW_TELEGRAM_GROUP: '-100',
        OPENCLAW_ALERT_TOPIC: '5',
      },
      async () => {
        const Detector = await loadDetector();
        const d = new Detector();
        expect(d.alertMode).toBe('telegram');
      },
    );
  });

  test('returns "telegram_stdout" when only group is configured', async () => {
    await withEnv(
      {
        OPENCLAW_OWNER_IDS: '1',
        OPENCLAW_TELEGRAM_GROUP: '-100',
        OPENCLAW_ALERT_TOPIC: undefined,
      },
      async () => {
        const Detector = await loadDetector();
        const d = new Detector();
        expect(d.alertMode).toBe('telegram_stdout');
      },
    );
  });

  test('returns "stdout" when neither group nor topic is configured', async () => {
    await withEnv(
      {
        OPENCLAW_OWNER_IDS: undefined,
        OPENCLAW_TELEGRAM_GROUP: undefined,
        OPENCLAW_ALERT_TOPIC: undefined,
      },
      async () => {
        const Detector = await loadDetector();
        const d = new Detector();
        expect(d.alertMode).toBe('stdout');
      },
    );
  });
});

// ─── 4-6: filterTelegramSessions (ported) ──────────────────────────────

describe('filterTelegramSessions', () => {
  test('filters Telegram group sessions for the configured group', async () => {
    await withEnv(
      {
        OPENCLAW_TELEGRAM_GROUP: '-1001234567890',
        OPENCLAW_ALERT_TOPIC: '12345',
      },
      async () => {
        const Detector = await loadDetector();
        const d = new Detector();
        const sessions = [
          { key: 'agent:main:telegram:group:-1001234567890:topic:12345', kind: 'group', sessionId: 'a' },
          { key: 'agent:main:discord:channel:123456', kind: 'channel', sessionId: 'b' },
          { key: 'agent:main:telegram:group:-1001234567890:topic:67890', kind: 'group', sessionId: 'c' },
          { key: 'agent:main:telegram:group:-9999999999:topic:99999', kind: 'group', sessionId: 'd' },
        ];
        const filtered = d.filterTelegramSessions(sessions);
        expect(filtered).toHaveLength(2);
        expect(filtered.every((s: any) => s.key.includes('telegram:group:-1001234567890'))).toBe(true);
      },
    );
  });

  test('returns empty array when TELEGRAM_GROUP_ID is not configured', async () => {
    await withEnv({ OPENCLAW_TELEGRAM_GROUP: undefined }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      const sessions = [
        { key: 'agent:main:telegram:group:-100:topic:1', kind: 'group', sessionId: 'a' },
      ];
      expect(d.filterTelegramSessions(sessions)).toHaveLength(0);
    });
  });

  test('returns empty array when no sessions match the configured group', async () => {
    await withEnv({ OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      const sessions = [{ key: 'agent:main:discord:channel:1', kind: 'channel', sessionId: 'a' }];
      expect(d.filterTelegramSessions(sessions)).toHaveLength(0);
    });
  });
});

// ─── 7-10: detectDroppedMessages (ported + AGGRESSIVE-aware) ───────────

describe('detectDroppedMessages', () => {
  test('detects sessions with abortedLastRun set', async () => {
    await withEnv({ OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      d.restartTime = new Date('2026-05-06T12:53:45Z').getTime();
      const sessions = [
        {
          key: 'agent:main:telegram:group:-100:topic:12345',
          sessionId: 'abc123',
          updatedAt: new Date('2026-05-06T12:55:00Z').getTime(),
          abortedLastRun: true,
        },
      ];
      const dropped = await d.detectDroppedMessages(sessions);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        sessionKey: 'agent:main:telegram:group:-100:topic:12345',
        topic: '12345',
        sessionId: 'abc123',
        abortedLastRun: true,
        reason: 'Session aborted on last run',
      });
    });
  });

  test('extracts topic ID from the session key', async () => {
    await withEnv({ OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      d.restartTime = Date.now();
      const sessions = [
        {
          key: 'agent:main:telegram:group:-100:topic:99888',
          sessionId: 'xyz',
          updatedAt: Date.now(),
          abortedLastRun: true,
        },
      ];
      const dropped = await d.detectDroppedMessages(sessions);
      expect(dropped[0].topic).toBe('99888');
    });
  });

  test('handles malformed session keys gracefully (topic="unknown")', async () => {
    await withEnv({ OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      d.restartTime = Date.now();
      const sessions = [
        {
          key: 'malformed:session:key',
          sessionId: 'bad',
          updatedAt: Date.now(),
          abortedLastRun: true,
        },
      ];
      const dropped = await d.detectDroppedMessages(sessions);
      expect(dropped[0].topic).toBe('unknown');
    });
  });

  test('does NOT fire suspicious-gap heuristic when AGGRESSIVE is unset (C-default-off)', async () => {
    await withEnv(
      {
        OPENCLAW_TELEGRAM_GROUP: '-100',
        OPENCLAW_RESTART_SWEEP_AGGRESSIVE: undefined,
      },
      async () => {
        const Detector = await loadDetector();
        const d = new Detector();
        const restartTime = new Date('2026-05-06T12:53:45Z').getTime();
        d.restartTime = restartTime;
        // Session active 2 min before restart, no abortedLastRun.
        const sessions = [
          {
            key: 'agent:main:telegram:group:-100:topic:67890',
            sessionId: 'def',
            updatedAt: restartTime - 2 * 60 * 1000,
            abortedLastRun: false,
          },
        ];
        // Mock "now" to be 15 min past restart so the post-window condition is true
        const realNow = Date.now;
        Date.now = () => restartTime + 15 * 60 * 1000;
        try {
          const dropped = await d.detectDroppedMessages(sessions);
          // AGGRESSIVE off → secondary heuristic silent
          expect(dropped).toHaveLength(0);
        } finally {
          Date.now = realNow;
        }
      },
    );
  });

  test('fires suspicious-gap heuristic when AGGRESSIVE=1 (C-opt-in)', async () => {
    await withEnv(
      {
        OPENCLAW_TELEGRAM_GROUP: '-100',
        OPENCLAW_RESTART_SWEEP_AGGRESSIVE: '1',
      },
      async () => {
        const Detector = await loadDetector();
        const d = new Detector();
        const restartTime = new Date('2026-05-06T12:53:45Z').getTime();
        d.restartTime = restartTime;
        const sessions = [
          {
            key: 'agent:main:telegram:group:-100:topic:67890',
            sessionId: 'def',
            updatedAt: restartTime - 2 * 60 * 1000, // 2 min before restart
            abortedLastRun: false,
          },
        ];
        const realNow = Date.now;
        Date.now = () => restartTime + 15 * 60 * 1000;
        try {
          const dropped = await d.detectDroppedMessages(sessions);
          expect(dropped).toHaveLength(1);
          expect(dropped[0]).toMatchObject({
            suspiciousGap: true,
            reason: 'Active before restart, silent after',
          });
        } finally {
          Date.now = realNow;
        }
      },
    );
  });
});

// ─── Timing window correctness (NEW) ──────────────────────────────────

test('AGGRESSIVE: timing window — outside the 5-min-before window does NOT fire', async () => {
  await withEnv(
    {
      OPENCLAW_TELEGRAM_GROUP: '-100',
      OPENCLAW_RESTART_SWEEP_AGGRESSIVE: '1',
    },
    async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      const restartTime = new Date('2026-05-06T12:53:45Z').getTime();
      d.restartTime = restartTime;
      const sessions = [
        {
          key: 'agent:main:telegram:group:-100:topic:1',
          sessionId: 'old',
          updatedAt: restartTime - 30 * 60 * 1000, // 30 min before — OUTSIDE 5-min window
          abortedLastRun: false,
        },
      ];
      const realNow = Date.now;
      Date.now = () => restartTime + 15 * 60 * 1000;
      try {
        const dropped = await d.detectDroppedMessages(sessions);
        expect(dropped).toHaveLength(0);
      } finally {
        Date.now = realNow;
      }
    },
  );
});

// ─── 11-12: log parsing regex (ported) ────────────────────────────────

describe('bootstrap log timestamp regex', () => {
  test('extracts timestamp from "Gateway token synced" line', () => {
    const logLine = '2026-05-06 12:53:45 Gateway token synced to .env';
    const match = logLine.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('2026-05-06 12:53:45');
  });

  test('extracts timestamp from "OpenClaw gateway" line', () => {
    const logLine = '2026-05-06 12:53:45 ✅ OpenClaw gateway started';
    const match = logLine.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('2026-05-06 12:53:45');
  });
});

// ─── Idempotency: loadAlerted (NEW, D4 + 30-day prune) ─────────────────

describe('loadAlerted', () => {
  test('returns empty Map when alerted.json does not exist', async () => {
    const stateRoot = makeStateDir();
    await withEnv({ GBRAIN_HOME: stateRoot, OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      const map = await d.loadAlerted();
      expect(map.size).toBe(0);
    });
  });

  test('returns empty Map + warns on corrupt JSON (D4)', async () => {
    const stateRoot = makeStateDir();
    const stateDir = join(stateRoot, 'integrations', 'restart-sweep');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'alerted.json'), '{ this is not valid json');
    await withEnv({ GBRAIN_HOME: stateRoot, OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      // Capture stderr warning
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: any[]) => warnings.push(args.join(' '));
      try {
        const map = await d.loadAlerted();
        expect(map.size).toBe(0);
        expect(warnings.some(w => w.includes('Failed to load') || w.includes('alerted.json'))).toBe(true);
      } finally {
        console.warn = origWarn;
      }
    });
  });

  test('prunes entries older than 30 days', async () => {
    const stateRoot = makeStateDir();
    const stateDir = join(stateRoot, 'integrations', 'restart-sweep');
    mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(stateDir, 'alerted.json'),
      JSON.stringify({
        'old-session': { lastAlertedAt: fortyDaysAgo, restartTime: fortyDaysAgo },
        'fresh-session': { lastAlertedAt: oneDayAgo, restartTime: oneDayAgo },
      }),
    );
    await withEnv({ GBRAIN_HOME: stateRoot, OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      const map = await d.loadAlerted();
      expect(map.size).toBe(1);
      expect(map.has('fresh-session')).toBe(true);
      expect(map.has('old-session')).toBe(false);
    });
  });
});

// ─── Idempotency: saveAlerted atomic write (NEW, D3) ──────────────────

test('saveAlerted writes via tmp+rename (atomic, no leftover .tmp)', async () => {
  const stateRoot = makeStateDir();
  await withEnv({ GBRAIN_HOME: stateRoot, OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
    const Detector = await loadDetector();
    const d = new Detector();
    const stateDir = join(stateRoot, 'integrations', 'restart-sweep');
    mkdirSync(stateDir, { recursive: true });
    d.alerted = new Map([
      ['session-1', { lastAlertedAt: new Date().toISOString(), restartTime: new Date().toISOString() }],
    ]);
    await d.saveAlerted();
    // alerted.json exists, no leftover .tmp file
    const files = readdirSync(stateDir);
    expect(files).toContain('alerted.json');
    expect(files).not.toContain('alerted.json.tmp');
    // Round-trip: load returns the same data
    const map = await d.loadAlerted();
    expect(map.size).toBe(1);
    expect(map.get('session-1').lastAlertedAt).toBeDefined();
  });
});

// ─── Cooldown layer (NEW, C1) ──────────────────────────────────────────

describe('cooldown layer (C1)', () => {
  test('isInCooldown returns false when sessionKey is not in alerted map', async () => {
    await withEnv({ OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      d.alerted = new Map();
      expect(d.isInCooldown('agent:main:telegram:group:-100:topic:1')).toBe(false);
    });
  });

  test('cooldown suppresses re-alert within 6h even when restartTime is unstable (the C1 bug)', async () => {
    const stateRoot = makeStateDir();
    await withEnv({ GBRAIN_HOME: stateRoot, OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      const sessionKey = 'agent:main:telegram:group:-100:topic:42';
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      // Simulate: a prior cycle alerted this session 1h ago with synthesized restartTime A.
      d.alerted = new Map([
        [sessionKey, { lastAlertedAt: oneHourAgo, restartTime: 'restart-A' }],
      ]);
      // Current cycle: restartTime is now "restart-B" (synthesized fresh, different).
      // Without cooldown the original key-only logic would treat this as new
      // and re-alert. Cooldown short-circuits.
      expect(d.isInCooldown(sessionKey)).toBe(true);
    });
  });

  test('cooldown expires — entry older than 6h fires again', async () => {
    await withEnv({ OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
      const Detector = await loadDetector();
      const d = new Detector();
      const sessionKey = 'agent:main:telegram:group:-100:topic:99';
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
      d.alerted = new Map([
        [sessionKey, { lastAlertedAt: sevenHoursAgo, restartTime: sevenHoursAgo }],
      ]);
      expect(d.isInCooldown(sessionKey)).toBe(false);
    });
  });
});

// ─── Cooldown round-trip across two invocations (NEW) ─────────────────

test('round-trip: second invocation skips already-alerted session within cooldown', async () => {
  const stateRoot = makeStateDir();
  await withEnv({ GBRAIN_HOME: stateRoot, OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
    const Detector = await loadDetector();

    // First "invocation": alert + record state
    const d1 = new Detector();
    const stateDir = join(stateRoot, 'integrations', 'restart-sweep');
    mkdirSync(stateDir, { recursive: true });
    d1.restartTime = Date.now();
    d1.alerted = new Map();
    d1.alerted.set('agent:main:telegram:group:-100:topic:7', {
      lastAlertedAt: new Date().toISOString(),
      restartTime: new Date(d1.restartTime).toISOString(),
    });
    await d1.saveAlerted();

    // Second "invocation": fresh detector, loads state, cooldown blocks
    const d2 = new Detector();
    d2.alerted = await d2.loadAlerted();
    expect(d2.isInCooldown('agent:main:telegram:group:-100:topic:7')).toBe(true);
    expect(d2.isInCooldown('agent:main:telegram:group:-100:topic:other')).toBe(false);
  });
});

// ─── Alert formatting: real \n, not literal (NEW) ──────────────────────

test('alert text contains real newlines (not literal \\n)', async () => {
  await withEnv({ OPENCLAW_TELEGRAM_GROUP: '-100', OPENCLAW_ALERT_TOPIC: '5' }, async () => {
    const Detector = await loadDetector();
    let captured = '';
    const mockExecFile = (_cmd: string, argv: string[], cb: any) => {
      captured = argv[argv.indexOf('--message') + 1];
      cb(null, '', '');
    };
    const d = new Detector({ execFile: mockExecFile });
    await d.alertOnDroppedMessages([
      { sessionKey: 'k1', topic: '5', reason: 'Session aborted on last run', lastUpdate: '2026-05-06T12:00:00Z' },
    ]);
    // Real newlines, not the literal two-char sequence backslash-n
    expect(captured).toContain('\n');
    expect(captured).not.toContain('\\n');
  });
});

// ─── execFile shape + shell-injection defense (NEW) ────────────────────

test('sendTelegramAlert calls execFile with argv array (no shell, no metachar interpretation)', async () => {
  // Defense in depth: even if env contains shell metachars, execFile (not exec)
  // means they end up as literal string args, not interpreted by /bin/sh.
  await withEnv(
    {
      OPENCLAW_TELEGRAM_GROUP: '-100; rm -rf /',
      OPENCLAW_ALERT_TOPIC: '$(reboot)',
    },
    async () => {
      const Detector = await loadDetector();
      const calls: any[] = [];
      const mockExecFile = (cmd: string, argv: string[], cb: any) => {
        calls.push({ cmd, argv });
        cb(null, '', '');
      };
      const d = new Detector({ execFile: mockExecFile });
      await d.sendTelegramAlert('test message');
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('openclaw');
      expect(calls[0].argv).toEqual([
        'message', 'send',
        '--channel', 'telegram',
        '--target', '-100; rm -rf /',
        '--thread-id', '$(reboot)',
        '--message', 'test message',
      ]);
      // The dangerous strings are passed as literal argv elements — no shell can interpret them
      expect(calls[0].argv).toContain('-100; rm -rf /');
      expect(calls[0].argv).toContain('$(reboot)');
    },
  );
});

// ─── GBRAIN_HOME state path override (NEW, D2 verification) ────────────

test('GBRAIN_HOME env override redirects state file to env-pointed dir', async () => {
  const customRoot = makeStateDir();
  await withEnv({ GBRAIN_HOME: customRoot, OPENCLAW_TELEGRAM_GROUP: '-100' }, async () => {
    const Detector = await loadDetector();
    const d = new Detector();
    expect(d.STATE_DIR).toBe(join(customRoot, 'integrations', 'restart-sweep'));
    expect(d.ALERTED_PATH).toBe(join(customRoot, 'integrations', 'restart-sweep', 'alerted.json'));
    expect(d.LOG_PATH).toBe(join(customRoot, 'integrations', 'restart-sweep', 'sweep.log.jsonl'));
  });
});

// ─── Constructor-time env reads (NEW, C2 contract) ─────────────────────

test('env reads happen at construct time, not module load (C2)', async () => {
  // Verifies the C2 fix: the original script snapshotted env at module load,
  // making constructor-mode tests semantically bogus. We move env reads to
  // the constructor; mutating env between constructions changes the result.
  const Detector = await loadDetector();

  await withEnv(
    {
      OPENCLAW_TELEGRAM_GROUP: '-100',
      OPENCLAW_ALERT_TOPIC: '5',
    },
    async () => {
      const d1 = new Detector();
      expect(d1.alertMode).toBe('telegram');
    },
  );

  await withEnv(
    {
      OPENCLAW_TELEGRAM_GROUP: '-100',
      OPENCLAW_ALERT_TOPIC: undefined,
    },
    async () => {
      // Same module instance, new construction → reflects mutated env
      const d2 = new Detector();
      expect(d2.alertMode).toBe('telegram_stdout');
    },
  );

  await withEnv(
    {
      OPENCLAW_TELEGRAM_GROUP: undefined,
      OPENCLAW_ALERT_TOPIC: undefined,
    },
    async () => {
      const d3 = new Detector();
      expect(d3.alertMode).toBe('stdout');
    },
  );
});

/**
 * Harness hook entries that lost their `_gbrain` marker (#6092, #6171).
 * Claude Code can drop unknown keys when it rewrites settings.json, so the
 * harness lane recognizes its own unmarked entries by an anchored parse of
 * exactly the command buildClaudeHookCommand writes, scoped per event and
 * bound to this install's launcher/source/seat (receipt-backed). Anything else
 * that merely looks like a harness hook is unowned and never deleted.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeHookCommand,
  classifyHarnessHook,
  groupsCarryGbrainHook,
  harnessHookIdentity,
  parseClaudeHookCommand,
  removeClaudeHooksAt,
  scanHarnessHookCarrier,
  writeClaudeHooksAt,
  type ClaudeHookEnv,
  type HarnessHookIdentity,
} from '../src/core/bootstrap/hooks.ts';
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_SUBCOMMAND,
  GBRAIN_HARNESS_MARKER_VALUE,
  GBRAIN_HOOK_MARKER_KEY,
  type ClaudeHookEvent,
} from '../src/core/bootstrap/host-specs.ts';

const BIN = '/opt/fake/gbrain';
const OLD_BIN = '/home/alice-example/gbrain-clone/bin/gbrain';
const ME: HarnessHookIdentity = { launchers: [BIN], sources: ['default'] };
const HARNESS_ENV: ClaudeHookEnv = { GBRAIN_SOURCE: 'default', GBRAIN_HOOK_LANE: 'harness' };

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'gb-hook-own-')), 'settings.json');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function entry(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'command', command, timeout: 5, ...extra };
}

/** Our five harness entries with the marker stripped, as the host leaves them. */
function strippedHarnessHooks(bin = BIN, env: ClaudeHookEnv = HARNESS_ENV): Record<string, unknown[]> {
  return Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [{ hooks: [entry(buildClaudeHookCommand(bin, e, env))] }]]));
}

function flat(settings: Record<string, unknown>, event: string): Array<Record<string, unknown>> {
  const groups = ((settings.hooks ?? {}) as Record<string, unknown[]>)[event] ?? [];
  return groups.flatMap((g) => ((g as { hooks?: unknown[] }).hooks ?? []) as Array<Record<string, unknown>>);
}

describe('parseClaudeHookCommand (inverse of buildClaudeHookCommand)', () => {
  test('round-trips every event, env combination and quoted launcher', () => {
    const bins = [BIN, '/Users/alice example/.bun/bin/gbrain', "/tmp/it's here/gbrain", '/opt/a@b:c/gbrain'];
    const envs: ClaudeHookEnv[] = [];
    for (const source of [undefined, '', 'default', 'acme-notes']) {
      for (const home of [undefined, '/srv/brain home']) {
        for (const lane of [undefined, 'harness']) {
          for (const seat of [undefined, 'alice-desk']) {
            envs.push({
              ...(source !== undefined ? { GBRAIN_SOURCE: source } : {}),
              ...(home ? { GBRAIN_HOME: home } : {}),
              ...(lane ? { GBRAIN_HOOK_LANE: lane } : {}),
              ...(seat ? { GBRAIN_SEAT: seat } : {}),
            });
          }
        }
      }
    }
    let n = 0;
    for (const bin of bins) {
      for (const env of envs) {
        for (const event of CLAUDE_HOOK_EVENTS) {
          const command = buildClaudeHookCommand(bin, event, env);
          const parsed = parseClaudeHookCommand(command);
          expect(parsed).toEqual({ gbrainBin: bin, subcommand: CLAUDE_HOOK_SUBCOMMAND[event], env });
          n++;
        }
      }
    }
    expect(n).toBe(bins.length * envs.length * CLAUDE_HOOK_EVENTS.length);
  });

  test('rejects anything the builder would not write', () => {
    const good = buildClaudeHookCommand(BIN, 'Stop', HARNESS_ENV);
    expect(parseClaudeHookCommand(good)).not.toBeNull();
    for (const bad of [
      `${good} | tee /tmp/log`,
      `${good} --debug`,
      `${good} `,
      ` ${good}`,
      good.replace('env ', 'env  '),
      `env GBRAIN_SOURCE=default GBRAIN_SOURCE=other GBRAIN_HOOK_LANE=harness ${BIN} hook stop`,
      `env GBRAIN_HOOK_LANE=harness GBRAIN_SOURCE=default ${BIN} hook stop`,
      `env FOO=1 GBRAIN_HOOK_LANE=harness ${BIN} hook stop`,
      `env 'GBRAIN_SOURCE=default' GBRAIN_HOOK_LANE=harness ${BIN} hook stop`,
      `env GBRAIN_HOOK_LANE=harness gbrain hook stop`,
      `env GBRAIN_HOOK_LANE=harness ${BIN} hook stop extra`,
      `env GBRAIN_HOOK_LANE=harness ${BIN} hook not-an-event`,
      `GBRAIN_HOOK_LANE=harness ${BIN} hook stop`,
      `env GBRAIN_HOME= GBRAIN_HOOK_LANE=harness ${BIN} hook stop`,
    ]) {
      expect(parseClaudeHookCommand(bad)).toBeNull();
    }
  });
});

describe('classifyHarnessHook: grammar is not ownership', () => {
  const stop = (bin = BIN, env: ClaudeHookEnv = HARNESS_ENV) => entry(buildClaudeHookCommand(bin, 'Stop', env));

  test('marked, owned command, and identity-free shape match', () => {
    expect(classifyHarnessHook({ ...stop(), [GBRAIN_HOOK_MARKER_KEY]: GBRAIN_HARNESS_MARKER_VALUE }, 'Stop', ME)?.ownership).toBe('marked');
    const owned = classifyHarnessHook(stop(), 'Stop', ME);
    expect(owned?.ownership).toBe('command');
    expect(owned?.why).not.toContain(BIN);
    expect(classifyHarnessHook(stop(OLD_BIN), 'Stop', 'any')?.ownership).toBe('command');
  });

  test('differing launchers, homes, sources and seats are unowned', () => {
    expect(classifyHarnessHook(stop(OLD_BIN), 'Stop', ME)?.ownership).toBe('unowned');
    expect(classifyHarnessHook(stop('/custom/tool'), 'Stop', ME)?.ownership).toBe('unowned');
    expect(classifyHarnessHook(stop(BIN, { ...HARNESS_ENV, GBRAIN_HOME: '/srv/other' }), 'Stop', ME)?.ownership).toBe('unowned');
    expect(classifyHarnessHook(stop(BIN, { GBRAIN_SOURCE: 'acme-notes', GBRAIN_HOOK_LANE: 'harness' }), 'Stop', ME)?.ownership).toBe('unowned');
    const seated = stop(BIN, { ...HARNESS_ENV, GBRAIN_SEAT: 'alice-desk' });
    expect(classifyHarnessHook(seated, 'Stop', { ...ME, seats: [''] })?.ownership).toBe('unowned');
    expect(classifyHarnessHook(seated, 'Stop', { ...ME, seats: ['alice-desk'] })?.ownership).toBe('command');
    expect(classifyHarnessHook(seated, 'Stop', ME)?.ownership).toBe('command');
  });

  test('event scoping, edits, other markers and foreign hooks', () => {
    expect(classifyHarnessHook(stop(), 'SubagentStop', ME)).toBeNull();
    expect(classifyHarnessHook(stop(), 'SessionStart', ME)?.ownership).toBe('unowned');
    expect(classifyHarnessHook(entry(`${buildClaudeHookCommand(BIN, 'Stop', HARNESS_ENV)} | tee log`), 'Stop', ME)?.ownership).toBe('unowned');
    expect(classifyHarnessHook({ ...stop(), [GBRAIN_HOOK_MARKER_KEY]: 'bootstrap-v1' }, 'Stop', ME)).toBeNull();
    expect(classifyHarnessHook(entry(buildClaudeHookCommand(BIN, 'Stop', { GBRAIN_SOURCE: 'ws' })), 'Stop', ME)).toBeNull();
    expect(classifyHarnessHook(entry('echo hi'), 'Stop', ME)).toBeNull();
  });
});

describe('harnessHookIdentity', () => {
  test('merges the current install with the receipt-recorded launcher, source and seat', () => {
    const receipt = { source_id: 'default' };
    expect(harnessHookIdentity(receipt, { launcher: OLD_BIN, seat: 'alice-desk' }, { launcher: BIN, source: 'acme-notes', seat: 'desk-2' }))
      .toEqual({ launchers: [BIN, OLD_BIN], sources: ['acme-notes', 'default'], seats: ['alice-desk', 'desk-2'] });
  });

  test('a legacy receipt (no launcher or seat recorded) leaves seats open; an unpinned receipt claims no-source hooks', () => {
    expect(harnessHookIdentity({ source_id: 'default', source_pinned: false }, {}, { launcher: null }))
      .toEqual({ launchers: [], sources: [null] });
  });
});

describe('writeClaudeHooksAt converges over marker-stripped entries (#6171)', () => {
  test('re-run leaves exactly one marked entry per event; the rest of the file is unchanged', () => {
    const path = tmpFile();
    const userStop = { matcher: '', hooks: [entry('/usr/local/bin/notify-done')] };
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)', 'mcp__gbrain'] },
      enabledPlugins: { 'other@market': true },
      hooks: { Stop: [userStop], SubagentStop: [{ hooks: [entry(buildClaudeHookCommand(BIN, 'Stop', HARNESS_ENV))] }] } as Record<string, unknown[]>,
    };
    for (const [event, groups] of Object.entries(strippedHarnessHooks())) {
      original.hooks[event] = [...(original.hooks[event] ?? []), ...groups];
    }
    writeFileSync(path, JSON.stringify(original, null, 2));

    const r = writeClaudeHooksAt(path, { gbrainBin: BIN, env: HARNESS_ENV, marker: GBRAIN_HARNESS_MARKER_VALUE, identity: ME });
    expect(r.removedPrior).toBe(CLAUDE_HOOK_EVENTS.length);
    const after = readJson(path);
    for (const event of CLAUDE_HOOK_EVENTS) {
      const ours = flat(after, event).filter((e) => typeof e.command === 'string' && (e.command as string).includes('GBRAIN_HOOK_LANE=harness'));
      expect(ours).toHaveLength(1);
      expect(ours[0]![GBRAIN_HOOK_MARKER_KEY]).toBe(GBRAIN_HARNESS_MARKER_VALUE);
    }
    const { hooks, ...rest } = after;
    const { hooks: originalHooks, ...originalRest } = original;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(originalRest));
    const afterHooks = hooks as Record<string, unknown[]>;
    expect(afterHooks.Stop![0]).toEqual(userStop);
    expect(afterHooks.SubagentStop).toEqual(originalHooks.SubagentStop);
  });

  test('another launcher, home or source survives the install, and the note names the code', () => {
    const path = tmpFile();
    const hooks = strippedHarnessHooks(OLD_BIN);
    hooks.SessionStart = [{ hooks: [entry(buildClaudeHookCommand(BIN, 'SessionStart', { ...HARNESS_ENV, GBRAIN_HOME: '/srv/other' }))] }];
    hooks.UserPromptSubmit = [{ hooks: [entry(buildClaudeHookCommand(BIN, 'UserPromptSubmit', { GBRAIN_SOURCE: 'acme-notes', GBRAIN_HOOK_LANE: 'harness' }))] }];
    writeFileSync(path, JSON.stringify({ hooks }));
    const r = writeClaudeHooksAt(path, { gbrainBin: BIN, env: HARNESS_ENV, marker: GBRAIN_HARNESS_MARKER_VALUE, identity: ME });
    expect(r.removedPrior).toBe(0);
    expect(r.notes.filter((n) => n.includes('harness_hook_unowned'))).toHaveLength(CLAUDE_HOOK_EVENTS.length);
    for (const event of CLAUDE_HOOK_EVENTS) expect(flat(readJson(path), event)).toHaveLength(2);
  });

  test('a launcher the receipt recorded is claimed (bun-global install replaced by a clone)', () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ hooks: strippedHarnessHooks(OLD_BIN) }));
    const identity = harnessHookIdentity({ source_id: 'default' }, { launcher: OLD_BIN }, { launcher: BIN, source: 'default' });
    const r = writeClaudeHooksAt(path, { gbrainBin: BIN, env: HARNESS_ENV, marker: GBRAIN_HARNESS_MARKER_VALUE, identity });
    expect(r.removedPrior).toBe(CLAUDE_HOOK_EVENTS.length);
    for (const event of CLAUDE_HOOK_EVENTS) expect(flat(readJson(path), event).map((e) => e.command)).toEqual([buildClaudeHookCommand(BIN, event, HARNESS_ENV)]);
  });

  test('the seat an unmarked entry carried is kept on re-run', () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ hooks: strippedHarnessHooks(BIN, { ...HARNESS_ENV, GBRAIN_SEAT: 'alice-desk' }) }));
    const r = writeClaudeHooksAt(path, { gbrainBin: BIN, env: HARNESS_ENV, marker: GBRAIN_HARNESS_MARKER_VALUE, identity: ME });
    expect(r.seat).toBe('alice-desk');
    expect(r.installed.every((i) => i.command.includes('GBRAIN_SEAT=alice-desk'))).toBe(true);
  });
});

describe('removeClaudeHooksAt removes unmarked-but-ours entries (#6092)', () => {
  function fixture(): { path: string; before: string } {
    const path = tmpFile();
    const hooks = strippedHarnessHooks();
    hooks.Stop!.push({ hooks: [entry(`${buildClaudeHookCommand(BIN, 'Stop', HARNESS_ENV)} | tee /tmp/log`)] });
    hooks.SubagentStop = [{ hooks: [entry(buildClaudeHookCommand(BIN, 'Stop', HARNESS_ENV))] }];
    hooks.SessionStart!.push({ hooks: [entry('echo mine')] });
    const before = JSON.stringify({ model: 'opus', hooks }, null, 2);
    writeFileSync(path, before);
    return { path, before };
  }

  test('removes ours, lists each by event without command text, keeps and reports the near-miss', () => {
    const { path } = fixture();
    const r = removeClaudeHooksAt(path, GBRAIN_HARNESS_MARKER_VALUE, { identity: ME });
    expect(r.removed).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(r.unmarked.map((u) => u.event).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    for (const u of r.unmarked) {
      expect(u.why).not.toContain(BIN);
      expect(u.why).not.toContain('GBRAIN_HOOK_LANE');
    }
    expect(r.unowned).toEqual(['Stop']);
    const after = readJson(path);
    expect(flat(after, 'Stop').map((e) => e.command)).toEqual([`${buildClaudeHookCommand(BIN, 'Stop', HARNESS_ENV)} | tee /tmp/log`]);
    expect(flat(after, 'SubagentStop')).toHaveLength(1);
    expect(flat(after, 'SessionStart').map((e) => e.command)).toEqual(['echo mine']);
    expect(after.model).toBe('opus');
  });

  test('dryRun reports the same list and writes nothing', () => {
    const { path, before } = fixture();
    const r = removeClaudeHooksAt(path, GBRAIN_HARNESS_MARKER_VALUE, { identity: ME, dryRun: true });
    expect(r.removed).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(r.unmarked).toHaveLength(CLAUDE_HOOK_EVENTS.length);
    expect(r.unowned).toEqual(['Stop']);
    expect(r.backupPath).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('without an identity removal stays marker-only (workspace lane unchanged)', () => {
    const { path, before } = fixture();
    expect(removeClaudeHooksAt(path, GBRAIN_HARNESS_MARKER_VALUE).removed).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('scanHarnessHookCarrier and groupsCarryGbrainHook (read-only probes)', () => {
  test('counts marked, owned and unowned per event; an unparseable file says so', () => {
    const path = tmpFile();
    const hooks = strippedHarnessHooks();
    hooks.Stop!.push({ hooks: [entry(buildClaudeHookCommand(BIN, 'Stop', HARNESS_ENV), { [GBRAIN_HOOK_MARKER_KEY]: GBRAIN_HARNESS_MARKER_VALUE })] });
    hooks.PreCompact!.push({ hooks: [entry(buildClaudeHookCommand(OLD_BIN, 'PreCompact', HARNESS_ENV))] });
    writeFileSync(path, JSON.stringify({ hooks }));
    const scan = scanHarnessHookCarrier(path, ME);
    expect(scan.state).toBe('ok');
    expect(scan.events.Stop).toEqual({ marked: 1, command: 1, unowned: 0 });
    expect(scan.events.PreCompact).toEqual({ marked: 0, command: 1, unowned: 1 });
    expect(scanHarnessHookCarrier(path, 'any').events.PreCompact).toEqual({ marked: 0, command: 2, unowned: 0 });
    writeFileSync(path, '{ not json');
    expect(scanHarnessHookCarrier(path, ME).state).toBe('unparseable');
  });

  test('an unmarked harness command counts as a gbrain hook for carrier overlap', () => {
    const event: ClaudeHookEvent = 'SessionStart';
    expect(groupsCarryGbrainHook([{ hooks: [entry(buildClaudeHookCommand(BIN, event, HARNESS_ENV))] }], event)).toBe(true);
    expect(groupsCarryGbrainHook([{ hooks: [entry('echo hi')] }], event)).toBe(false);
    expect(groupsCarryGbrainHook([{ hooks: [entry('x', { [GBRAIN_HOOK_MARKER_KEY]: 'bootstrap-v1' })] }], event)).toBe(true);
  });
});

import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import { MUTEABLE_NOTICE_CODES } from '../src/core/ops/notices.ts';
import { setNoticeMuted } from '../src/core/notice-ledger.ts';
import { inertText } from '../src/core/agent-output.ts';
import { printInAgentReady } from '../src/core/agent-install/init-state.ts';
import { hostedOptionLine, hostedOptionMuted, hostedOptionNotice, writeHostedOption } from '../src/core/onboard/hosted-option.ts';

async function inHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-hosted-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); } finally { rmSync(home, { recursive: true, force: true }); }
}

function captured(fn: () => void): { stdout: string; stderr: string } {
  const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    fn();
    return { stdout: out.mock.calls.map(c => String(c[0])).join(''), stderr: err.mock.calls.map(c => String(c[0])).join('') };
  } finally { out.mockRestore(); err.mockRestore(); }
}

describe('hosted_option notice', () => {
  test('one coaching notice per surface with its ref tag, a statement, and the mute command', () => {
    for (const [where, ref] of [['setup', 'cli-setup'], ['in_agent', 'cli-in-agent'], ['mcp_expose', 'cli-mcp-expose'], ['mcp_expose_friction', 'cli-mcp-expose-friction']] as const) {
      const n = hostedOptionNotice(where, new Set())!;
      expect(n).toMatchObject({ code: 'hosted_option', kind: 'coaching' });
      expect(n.user_message).toContain(`https://gbrain.io/?ref=${ref}`);
      expect(n.user_message).toContain('gbrain notices mute hosted_option');
      expect(n.user_message).not.toMatch(/\?(\s|$)/);
      expect(inertText(n.user_message!)).toBe(n.user_message!);
      expect(inertText(n.why)).toBe(n.why);
    }
  });

  test('the registry row matches the builder kind, so the code is muteable', () => {
    expect(hostedOptionNotice('setup', new Set())!.kind).toBe(NOTICE_CODES.hosted_option.kind);
    expect(MUTEABLE_NOTICE_CODES).toContain('hosted_option');
  });

  test('muted on the owner list or on the stdio audience means no notice', async () => {
    await inHome(() => {
      expect(hostedOptionNotice('setup', hostedOptionMuted())).not.toBeNull();
      setNoticeMuted('hosted_option', true, 'stdio');
      expect(hostedOptionNotice('setup', hostedOptionMuted())).toBeNull();
      setNoticeMuted('hosted_option', false, 'stdio');
      setNoticeMuted('hosted_option', true);
      expect(hostedOptionNotice('setup', hostedOptionMuted())).toBeNull();
    });
  });

  test('a terminal gets one plain line; an agent gets the standard notice block', () => {
    const tty = captured(() => writeHostedOption('setup', new Set(), { tty: true }));
    expect(tty.stderr).toBe(`${hostedOptionLine('setup')}\n`);
    expect(tty.stdout).toBe('');
    const agent = captured(() => writeHostedOption('setup', new Set(), { tty: false }));
    expect(agent.stdout).toContain('[hosted_option]');
    expect(agent.stdout).toContain('https://gbrain.io/?ref=cli-setup');
    expect(captured(() => writeHostedOption('setup', new Set(['hosted_option']), { tty: true })).stderr).toBe('');
  });

  test('the in-agent ready text names hosted GBrain only for a brain it created, with the install\'s own launcher in the mute hint', async () => {
    await inHome(() => {
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        const db = '/tmp/agent root/data/brain.pglite';
        const shown = captured(() => printInAgentReady(db, true));
        expect(shown.stdout).toContain('https://gbrain.io/?ref=cli-in-agent');
        expect(shown.stdout).toContain("'/tmp/agent root/bin/gbrain' notices mute hosted_option");
        expect(captured(() => printInAgentReady(db, false)).stdout).not.toContain('gbrain.io');
        expect(captured(() => printInAgentReady(db)).stdout).not.toContain('gbrain.io');
      } finally { log.mockRestore(); }
    });
  });
});

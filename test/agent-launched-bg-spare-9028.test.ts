import { describe, test, expect } from 'bun:test';
import { detectAgentLaunched } from '../src/core/context/session-speaker.ts';

describe('agent-launched detection for claude --bg sessions (#9028)', () => {
  test('a claimed bg-spare session under a bg-pty-host is agent-launched', () => {
    const spare = { pid: 10, args: ['claude', 'bg-spare', '--bg-spare', '/run/spare/x.claim.sock'] };
    const host = { pid: 9, args: ['claude', 'bg-pty-host', '--bg-pty-host', '--', '/bin/claude', '--bg-spare'] };
    const shell = { pid: 11, args: ['zsh', '-c', 'npm test'] };
    expect(detectAgentLaunched([shell, spare, host])).toBe(true);
  });
  test('an interactive claude under another claude stays the owner', () => {
    expect(detectAgentLaunched([{ pid: 1, args: ['claude'] }, { pid: 2, args: ['claude'] }])).toBe(false);
  });
});

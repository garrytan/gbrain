/**
 * GST-2714: agents read `gbrain setup --help | head` to learn which harnesses setup
 * wires. The usage lines named only claude-code and codex, so OpenClaw agents in the
 * install eval registered MCP by hand and skipped `gbrain setup openclaw`, and a new
 * session never got the brain-first rule.
 */

import { describe, expect, test } from 'bun:test';
import { SETUP_HELP } from '../src/commands/setup.ts';

describe('gbrain setup --help usage', () => {
  test('the first lines name every harness setup writes instructions for', () => {
    const head = SETUP_HELP.split('\n').slice(0, 8).join('\n');
    for (const harness of ['claude-code', 'codex', 'openclaw', 'hermes', 'opencode', 'cursor']) expect(head).toContain(harness);
  });
});

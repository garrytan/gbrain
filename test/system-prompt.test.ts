/**
 * v0.41 Approach C — system-prompt renderer unit tests.
 *
 * Pins the deterministic-output contract that the Anthropic prompt-cache
 * marker on the system block depends on. Drifting the renderer's output
 * across invocations would silently miss the cache on every turn.
 *
 * Covers:
 *  - DEFAULT_SUBAGENT_SYSTEM fallback when userSystem is undefined.
 *  - Empty toolDefs → no preamble splice (falls through to bare system).
 *  - Single tool, no usage_hint → bare list entry.
 *  - Single tool, with usage_hint → list entry with " — hint" suffix.
 *  - Multi-tool — order preserved from input (no sort).
 *  - usage_hint with embedded newlines → normalized to single line.
 *  - usage_hint whitespace-only string → treated as missing.
 *  - no_tool_preamble opt-out → returns userSystem unchanged.
 *  - Determinism — two calls with identical input produce byte-identical output.
 *  - Plugin tool integration — registry-agnostic, works for any ToolDef.
 *  - Closing paragraph naming shell/bash + brain DB distinction present.
 *  - userSystem override fully preserved as the leading bytes (cache-hit safety).
 */

import { describe, test, expect } from 'bun:test';
import {
  buildSystemPrompt,
  renderToolPreamble,
  DEFAULT_SUBAGENT_SYSTEM,
} from '../src/core/minions/system-prompt.ts';
import type { ToolDef } from '../src/core/minions/types.ts';

function fakeTool(name: string, opts: { usage_hint?: string } = {}): ToolDef {
  return {
    name,
    description: `description of ${name}`,
    input_schema: { type: 'object' as const },
    idempotent: true,
    usage_hint: opts.usage_hint,
    async execute() {
      return null;
    },
  };
}

describe('buildSystemPrompt', () => {
  test('empty toolDefs + undefined userSystem → returns the DEFAULT bare system', () => {
    const out = buildSystemPrompt([], undefined);
    expect(out).toBe(DEFAULT_SUBAGENT_SYSTEM);
  });

  test('empty toolDefs + custom userSystem → returns userSystem unchanged (no preamble)', () => {
    const userSystem = 'You are a curator of brand archives.';
    const out = buildSystemPrompt([], userSystem);
    expect(out).toBe(userSystem);
  });

  test('no_tool_preamble=true keeps userSystem byte-for-byte even with tools', () => {
    const userSystem = 'Hand-tuned system prompt that should not be modified.';
    const tools = [fakeTool('search', { usage_hint: 'do searches' })];
    const out = buildSystemPrompt(tools, userSystem, { no_tool_preamble: true });
    expect(out).toBe(userSystem);
  });

  test('tools without usage_hint render as bare list entries', () => {
    const tools = [fakeTool('search'), fakeTool('get_page')];
    const out = buildSystemPrompt(tools, undefined);
    expect(out).toContain('- `search`');
    expect(out).toContain('- `get_page`');
    expect(out).not.toContain('- `search` —');
    expect(out).not.toContain('- `get_page` —');
  });

  test('tools with usage_hint render with " — hint" suffix', () => {
    const tools = [fakeTool('shell', { usage_hint: 'Run a shell command.' })];
    const out = buildSystemPrompt(tools, undefined);
    expect(out).toContain('- `shell` — Run a shell command.');
  });

  test('preamble preserves caller-supplied tool order (no sort)', () => {
    const tools = [
      fakeTool('z_last', { usage_hint: 'late' }),
      fakeTool('a_first', { usage_hint: 'early' }),
    ];
    const out = buildSystemPrompt(tools, undefined);
    const idxZ = out.indexOf('- `z_last`');
    const idxA = out.indexOf('- `a_first`');
    expect(idxZ).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxZ).toBeLessThan(idxA); // input order preserved
  });

  test('usage_hint with embedded newlines is normalized to single line', () => {
    const tools = [
      fakeTool('shell', {
        usage_hint: 'Line one.\nLine two.\n\tIndented line three.',
      }),
    ];
    const out = buildSystemPrompt(tools, undefined);
    // Whole hint collapses to single line; preamble layout intact.
    expect(out).toContain('- `shell` — Line one. Line two. Indented line three.');
    // No literal newlines inside the hint line.
    const hintLine = out.split('\n').find(l => l.startsWith('- `shell`'));
    expect(hintLine).toBeDefined();
    expect(hintLine!).not.toContain('\n');
  });

  test('whitespace-only usage_hint treated as missing', () => {
    const tools = [fakeTool('foo', { usage_hint: '   \t  ' })];
    const out = buildSystemPrompt(tools, undefined);
    expect(out).toContain('- `foo`');
    expect(out).not.toContain('- `foo` —');
  });

  test('closing paragraph names shell/bash + brain DB distinction (field-report fix)', () => {
    const tools = [fakeTool('shell', { usage_hint: 'Run commands.' })];
    const out = buildSystemPrompt(tools, undefined);
    expect(out).toContain('`shell` or `bash` tool');
    expect(out).toContain('gbrain database');
    expect(out).toContain('not to local files');
  });

  test('userSystem is the leading bytes of the output (Anthropic prompt-cache safety)', () => {
    const userSystem = 'Custom-tuned-prefix-for-cache-hit-stability.';
    const tools = [fakeTool('search', { usage_hint: 'do searches' })];
    const out = buildSystemPrompt(tools, userSystem);
    expect(out.startsWith(userSystem)).toBe(true);
    // Two newlines between userSystem and the preamble.
    expect(out.startsWith(userSystem + '\n\n')).toBe(true);
  });

  test('determinism: identical input → byte-identical output', () => {
    const tools = [
      fakeTool('a', { usage_hint: 'do A' }),
      fakeTool('b'),
      fakeTool('c', { usage_hint: 'do C' }),
    ];
    const userSystem = 'System.';
    const a = buildSystemPrompt(tools, userSystem);
    const b = buildSystemPrompt(tools, userSystem);
    expect(a).toBe(b);
    expect(a.length).toBe(b.length);
  });

  test('plugin tool (registry-agnostic) gets its usage_hint surfaced', () => {
    // Simulate a downstream OpenClaw plugin that registers a custom tool.
    const tools = [
      fakeTool('playwright_navigate', {
        usage_hint: 'Drive a browser to a URL and wait for load.',
      }),
    ];
    const out = buildSystemPrompt(tools, undefined);
    expect(out).toContain('- `playwright_navigate` — Drive a browser to a URL and wait for load.');
  });
});

describe('renderToolPreamble (pure)', () => {
  test('renders header + bullets + footer in canonical order', () => {
    const tools = [fakeTool('search', { usage_hint: 'do searches' })];
    const preamble = renderToolPreamble(tools);
    const lines = preamble.split('\n');
    // Header is first 3 lines.
    expect(lines[0]).toContain('You have the following tools available');
    expect(lines[1]).toContain('describe file contents');
    expect(lines[2]).toContain('Call the tool');
    // Then a blank line, then the tool list, then a blank, then the closer.
    expect(lines[3]).toBe('');
    expect(lines[4]).toContain('- `search`');
    expect(lines[5]).toBe('');
    expect(lines[6]).toContain('When the task asks you to write a file');
  });
});

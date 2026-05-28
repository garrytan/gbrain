/**
 * v0.41.16.0 — `gbrain conversation-parser` debug CLI tests.
 *
 * Pins:
 *   - list-builtins prints all 12 patterns + accepts --json
 *   - validate emits "deferred to v0.42+" notice (v1 has no compiler)
 *   - scan errors without engine
 *   - --help works
 *
 * Pure-function tests; no engine, no DB.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConversationParser } from '../src/commands/conversation-parser.ts';
import { BUILTIN_PATTERNS } from '../src/core/conversation-parser/builtins.ts';

// Capture process.stdout.write + process.stderr.write + process.exit.
function captureStdio() {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  // process.exit throws to short-circuit; tests catch and inspect.
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`PROCESS_EXIT:${exitCode}`);
  }) as typeof process.exit;
  return {
    out,
    err,
    getExitCode: () => exitCode,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      process.exit = origExit;
    },
  };
}

describe('runConversationParser — help', () => {
  test('--help prints usage', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['--help']);
    } finally {
      cap.restore();
    }
    const text = cap.out.join('');
    expect(text).toContain('Usage: gbrain conversation-parser');
    expect(text).toContain('scan');
    expect(text).toContain('list-builtins');
    expect(text).toContain('validate');
  });

  test('no subcommand prints help', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, []);
    } finally {
      cap.restore();
    }
    expect(cap.out.join('')).toContain('Usage: gbrain conversation-parser');
  });
});

describe('runConversationParser — list-builtins', () => {
  test('human output includes all 12 pattern ids', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['list-builtins']);
    } finally {
      cap.restore();
    }
    const text = cap.out.join('');
    for (const pattern of BUILTIN_PATTERNS) {
      expect(text).toContain(pattern.id);
    }
    expect(text).toContain(`${BUILTIN_PATTERNS.length} built-in patterns`);
  });

  test('--json output is stable schema', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['list-builtins', '--json']);
    } finally {
      cap.restore();
    }
    const json = JSON.parse(cap.out.join('').trim());
    expect(json.schema_version).toBe(1);
    expect(json.total).toBe(BUILTIN_PATTERNS.length);
    expect(json.patterns).toHaveLength(BUILTIN_PATTERNS.length);
    expect(json.patterns[0].id).toBe('imessage-slack');
    expect(json.patterns[0].date_source).toBeDefined();
    expect(json.patterns[0].time_format).toBeDefined();
    expect(json.patterns[0].timezone_policy).toBeDefined();
    expect(json.patterns[0].regex).toBeDefined();
  });
});

describe('runConversationParser — validate', () => {
  test('emits deferred notice (v0.42+ scope)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv-parser-cli-'));
    const path = join(dir, 'pattern.json');
    writeFileSync(path, '{}');
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['validate', path]);
    } finally {
      cap.restore();
    }
    expect(cap.out.join('')).toContain('deferred to v0.42+');
  });

  test('--json validate emits structured deferred envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv-parser-cli-'));
    const path = join(dir, 'pattern.json');
    writeFileSync(path, '{}');
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['validate', path, '--json']);
    } finally {
      cap.restore();
    }
    const json = JSON.parse(cap.out.join('').trim());
    expect(json.schema_version).toBe(1);
    expect(json.status).toBe('deferred');
    expect(json.todo_ref).toContain('v0.41.16.0');
  });

  test('exits 2 on missing file path', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['validate']);
    } catch (e) {
      expect((e as Error).message).toBe('PROCESS_EXIT:2');
    } finally {
      cap.restore();
    }
    expect(cap.getExitCode()).toBe(2);
  });

  test('exits 2 on nonexistent file', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, [
        'validate',
        '/nonexistent/path.json',
      ]);
    } catch (e) {
      expect((e as Error).message).toBe('PROCESS_EXIT:2');
    } finally {
      cap.restore();
    }
    expect(cap.getExitCode()).toBe(2);
  });
});

describe('runConversationParser — scan', () => {
  test('exits 2 when engine is null (scan requires brain)', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['scan', 'some-slug']);
    } catch (e) {
      expect((e as Error).message).toBe('PROCESS_EXIT:2');
    } finally {
      cap.restore();
    }
    expect(cap.getExitCode()).toBe(2);
  });
});

describe('runConversationParser — unknown subcommand', () => {
  test('exits 2 with hint', async () => {
    const cap = captureStdio();
    try {
      await runConversationParser(null, ['bogus-cmd']);
    } catch (e) {
      expect((e as Error).message).toBe('PROCESS_EXIT:2');
    } finally {
      cap.restore();
    }
    expect(cap.err.join('')).toContain('unknown subcommand');
  });
});

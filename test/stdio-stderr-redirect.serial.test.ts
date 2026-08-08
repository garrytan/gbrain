/**
 * v0.41.38+ — MCP stdio stderr redirect.
 *
 * The stdio MCP transport reserves stdout for JSON-RPC frames. Ops that run
 * in-process (sync_brain -> performSync -> runEmbedCore) emit progress via
 * slog / console.log; pre-fix those lines landed on stdout and every one made
 * the MCP client log "Failed to parse JSONRPC message" + a pydantic
 * ValidationError traceback.
 *
 * `redirectStdoutLoggingToStderr()` (called by the stdio serve path before
 * the transport starts) must:
 *   1. rebind console.log / console.info / console.debug to stderr
 *   2. route slog's PREFIXED path (process.stdout.write under
 *      withSourcePrefix) to process.stderr
 *   3. be idempotent
 *
 * Serial quarantine: this file mutates the global console bindings and the
 * module-level redirect flag. It must not share a test process with files
 * that assert bare console.log semantics (test/console-prefix.test.ts).
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  slog,
  withSourcePrefix,
  redirectStdoutLoggingToStderr,
  isStdoutLoggingRedirected,
  _resetStdoutRedirectForTests,
} from '../src/core/console-prefix.ts';

// Snapshot the real bindings ONCE, before any redirect call in this file.
/* eslint-disable no-console */
const realLog = console.log;
const realInfo = console.info;
const realDebug = console.debug;
const realError = console.error;
const realStderrWrite = process.stderr.write;
const realStdoutWrite = process.stdout.write;

afterAll(() => {
  console.log = realLog;
  console.info = realInfo;
  console.debug = realDebug;
  console.error = realError;
  process.stderr.write = realStderrWrite;
  process.stdout.write = realStdoutWrite;
  _resetStdoutRedirectForTests();
});

beforeEach(() => {
  console.log = realLog;
  console.info = realInfo;
  console.debug = realDebug;
  console.error = realError;
  process.stderr.write = realStderrWrite;
  process.stdout.write = realStdoutWrite;
  _resetStdoutRedirectForTests();
});

describe('redirectStdoutLoggingToStderr', () => {
  test('rebinds console.log/info/debug onto console.error (stderr)', () => {
    const errCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errCalls.push(args);
    };

    redirectStdoutLoggingToStderr();

    console.log('a', 1);
    console.info('b');
    console.debug('c');

    expect(errCalls).toEqual([['a', 1], ['b'], ['c']]);
    expect(isStdoutLoggingRedirected()).toBe(true);
  });

  test('slog prefixed path writes to stderr, not stdout, under redirect', async () => {
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];
    process.stderr.write = ((chunk: string) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutLines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    redirectStdoutLoggingToStderr();

    await withSourcePrefix('vault-brain', async () => {
      slog('projects/foo: all 12 chunks already embedded');
    });

    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual([
      '[vault-brain] projects/foo: all 12 chunks already embedded\n',
    ]);
  });

  test('slog unprefixed fallthrough lands on stderr via the console.log rebind', () => {
    const errCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errCalls.push(args);
    };

    redirectStdoutLoggingToStderr();
    slog('bare progress line');

    expect(errCalls).toEqual([['bare progress line']]);
  });

  test('idempotent: second call does not re-wrap (no double stderr emission)', () => {
    const errCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errCalls.push(args);
    };

    redirectStdoutLoggingToStderr();
    redirectStdoutLoggingToStderr();

    console.log('once');
    expect(errCalls).toEqual([['once']]);
  });

  test('without redirect, slog keeps bare console.log semantics (back-compat)', () => {
    const logCalls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      logCalls.push(args);
    };

    slog('normal cli output');
    expect(logCalls).toEqual([['normal cli output']]);
    expect(isStdoutLoggingRedirected()).toBe(false);
  });
});

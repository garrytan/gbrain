import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  formatHostedHttpFatal,
  installHostedHttpFatalHandlers,
  isFatalStatementTimeout,
  type FatalHandlerTarget,
} from '../src/core/http-fatal.ts';

function statementTimeout(): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
}

function userCancel(): Error {
  return Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
}

describe('isFatalStatementTimeout', () => {
  test('statement timeout is fatal', () => {
    expect(isFatalStatementTimeout(statementTimeout())).toBe(true);
  });

  test('user-request cancel is not labeled a statement timeout', () => {
    expect(isFatalStatementTimeout(userCancel())).toBe(false);
  });

  test('ordinary errors are not statement timeouts', () => {
    expect(isFatalStatementTimeout(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('installHostedHttpFatalHandlers', () => {
  test('unhandled statement timeout exits immediately and names 57014', () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    const logs: string[] = [];
    const off = installHostedHttpFatalHandlers({
      target: target as unknown as FatalHandlerTarget,
      exit: (code) => { exits.push(code); },
      log: (line) => { logs.push(line); },
    });
    try {
      target.emit('unhandledRejection', statementTimeout());
      expect(exits).toEqual([1]);
      expect(logs[0]).toContain('57014');
      expect(logs[0]).toContain('statement timeout');
      target.emit('unhandledRejection', new Error('again'));
      expect(exits).toEqual([1]);
    } finally {
      off();
    }
  });

  test('other unhandled rejections still exit, without the statement-timeout label', () => {
    const target = new EventEmitter();
    const logs: string[] = [];
    const exits: number[] = [];
    const off = installHostedHttpFatalHandlers({
      target: target as unknown as FatalHandlerTarget,
      exit: (code) => { exits.push(code); },
      log: (line) => { logs.push(line); },
    });
    try {
      target.emit('unhandledRejection', userCancel());
      expect(exits).toEqual([1]);
      expect(logs[0]).toContain('unhandledRejection');
      expect(logs[0]).not.toContain('fatal statement timeout');
    } finally {
      off();
    }
  });

  test('a caught statement timeout does not exit', async () => {
    const exits: number[] = [];
    const logs: string[] = [];
    const off = installHostedHttpFatalHandlers({
      exit: (code) => { exits.push(code); },
      log: (line) => { logs.push(line); },
    });
    try {
      await Promise.reject(statementTimeout()).catch(() => {});
      await new Promise(r => setTimeout(r, 20));
      expect(exits).toEqual([]);
      expect(logs).toEqual([]);
    } finally {
      off();
    }
  });

  test('unsubscribe stops handling', () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    const off = installHostedHttpFatalHandlers({
      target: target as unknown as FatalHandlerTarget,
      exit: (code) => { exits.push(code); },
      log: () => {},
    });
    off();
    target.emit('uncaughtException', statementTimeout());
    expect(exits).toEqual([]);
  });
});

describe('formatHostedHttpFatal', () => {
  test('uncaught exceptions exit with the same statement-timeout line', () => {
    expect(formatHostedHttpFatal('uncaughtException', statementTimeout())).toContain('fatal statement timeout');
  });
});

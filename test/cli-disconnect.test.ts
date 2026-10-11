import { describe, expect, test } from 'bun:test';
import { disconnectCliEngine, PGLITE_SKIP_CLOSE_COMMANDS } from '../src/core/cli-disconnect.ts';

describe('one-shot CLI disconnect deadline', () => {
  test('keeps the normal clean disconnect path', async () => {
    let disconnected = false;
    const outcome = await disconnectCliEngine({
      async disconnect() {
        disconnected = true;
      },
    }, 'import', { deadlineMs: 50 });

    expect(outcome).toBe('disconnected');
    expect(disconnected).toBe(true);
  });

  test('forces an already-completed import child to exit when disconnect wedges', async () => {
    const warnings: string[] = [];
    const exits: number[] = [];
    const outcome = await disconnectCliEngine({
      disconnect: () => new Promise<void>(() => {}),
    }, 'import', {
      deadlineMs: 10,
      exitCode: 7,
      forceExit: code => { exits.push(code); },
      warn: message => { warnings.push(message); },
    });

    expect(outcome).toBe('forced_exit');
    expect(exits).toEqual([7]);
    expect(warnings[0]).toContain('import completed');
    expect(warnings[0]).toContain('engine.disconnect() did not return');
  });

  test('PGLite one-shot CLI exits without waiting for a WASM close that can freeze the thread', async () => {
    const exits: number[] = [];
    let closed = false;
    const outcome = await disconnectCliEngine({
      kind: 'pglite',
      disconnect: async () => {
        closed = true;
        await new Promise(() => {});
      },
    }, 'import', {
      exitCode: 0,
      forceExit: code => { exits.push(code); },
    });

    expect(outcome).toBe('forced_exit');
    expect(closed).toBe(false);
    expect(exits).toEqual([0]);
  });

  test('PGLite one-shot CLI keeps a failed command exit code', async () => {
    const exits: number[] = [];
    const outcome = await disconnectCliEngine({
      kind: 'pglite',
      disconnect: async () => {},
    }, 'import', {
      exitCode: 1,
      forceExit: code => { exits.push(code); },
    });

    expect(outcome).toBe('forced_exit');
    expect(exits).toEqual([1]);
  });

  test('PGLite skip-close returns without waiting on disconnect or stdout drain', async () => {
    const exits: number[] = [];
    const started = Date.now();
    const outcome = await disconnectCliEngine({
      kind: 'pglite',
      disconnect: () => new Promise(() => {}),
    }, 'import', {
      forceExit: code => { exits.push(code); },
    });
    expect(outcome).toBe('forced_exit');
    expect(exits).toEqual([0]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('PGLite model commands also skip a Windows WASM close after their result is written', async () => {
    const exits: number[] = [];
    let disconnected = false;
    const outcome = await disconnectCliEngine({
      kind: 'pglite',
      async disconnect() {
        disconnected = true;
      },
    }, 'models', {
      forceExit: code => { exits.push(code); },
    });

    expect(PGLITE_SKIP_CLOSE_COMMANDS.has('models')).toBe(true);
    expect(PGLITE_SKIP_CLOSE_COMMANDS.has('import')).toBe(true);
    expect(PGLITE_SKIP_CLOSE_COMMANDS.has('think')).toBe(true);
    expect(outcome).toBe('forced_exit');
    expect(disconnected).toBe(false);
    expect(exits).toEqual([0]);
  });

  test('PGLite think also skips WASM close after the answer JSON is written', async () => {
    const exits: number[] = [];
    let disconnected = false;
    const outcome = await disconnectCliEngine({
      kind: 'pglite',
      async disconnect() {
        disconnected = true;
      },
    }, 'think', {
      forceExit: code => { exits.push(code); },
    });
    expect(outcome).toBe('forced_exit');
    expect(disconnected).toBe(false);
    expect(exits).toEqual([0]);
  });

  test('completed PGLite source commands return without closing WASM and preserve the actual verdict', async () => {
    for (const exitCode of [0, 1]) {
      const exits: number[] = [];
      let closed = false;
      const outcome = await disconnectCliEngine({
        kind: 'pglite',
        async disconnect() { closed = true; throw new Error('source close must not run'); },
      }, 'sources', { exitCode, forceExit: code => { exits.push(code); } });
      expect(outcome).toBe('forced_exit');
      expect(closed).toBe(false);
      expect(exits).toEqual([exitCode]);
    }
  });

  test('Postgres source commands retain the normal database disconnect', async () => {
    let closed = false;
    const exits: number[] = [];
    const outcome = await disconnectCliEngine({
      kind: 'postgres',
      async disconnect() { closed = true; },
    }, 'sources', { forceExit: code => { exits.push(code); } });
    expect(outcome).toBe('disconnected');
    expect(closed).toBe(true);
    expect(exits).toEqual([]);
  });
});

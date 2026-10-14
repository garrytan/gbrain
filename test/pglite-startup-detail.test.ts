import { describe, expect, test } from 'bun:test';
import { createWithStartupDetail } from '../src/core/pglite-startup-detail.ts';

describe('PGLite startup detail', () => {
  test('a normal open does not ask for debug logs', async () => {
    const modes: Array<0 | 1> = [];
    const db = await createWithStartupDetail(async debug => {
      modes.push(debug);
      return 'ready';
    });
    expect(db).toBe('ready');
    expect(modes).toEqual([0]);
  });

  test('other open errors are returned as they are', async () => {
    await expect(createWithStartupDetail(async () => {
      throw new Error('EPERM: operation not permitted');
    })).rejects.toThrow('EPERM: operation not permitted');
  });

  test('a generic process failure is opened once more and keeps the Postgres log', async () => {
    const modes: Array<0 | 1> = [];
    const previousError = console.error;
    try {
      await createWithStartupDetail(async debug => {
        modes.push(debug);
        if (debug === 1) console.error('FATAL: could not locate a valid checkpoint record');
        throw new Error('PGlite failed to initialize properly');
      });
      throw new Error('expected the second open to fail');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('PGlite failed to initialize properly');
      expect(message).toContain('could not locate a valid checkpoint record');
    } finally {
      console.error = previousError;
    }
    expect(modes).toEqual([0, 1]);
  });

  test('a debug retry that starts is kept', async () => {
    const db = await createWithStartupDetail(async debug => {
      if (debug === 0) throw new Error('PGlite failed to initialize properly');
      return 'recovered';
    });
    expect(db).toBe('recovered');
  });
});

import { describe, test, expect } from 'bun:test';
import { withEnv } from './with-env.ts';

const KEY = 'GBRAIN_WITH_ENV_TEST_KEY';
const KEY2 = 'GBRAIN_WITH_ENV_TEST_KEY2';

describe('withEnv', () => {
  test('sync callback: sets value, runs, restores prior value', async () => {
    process.env[KEY] = 'original';
    const result = await withEnv({ [KEY]: 'overridden' }, () => {
      expect(process.env[KEY]).toBe('overridden');
      return 42;
    });
    expect(result).toBe(42);
    expect(process.env[KEY]).toBe('original');
    delete process.env[KEY];
  });

  test('async callback: awaits, then restores', async () => {
    process.env[KEY] = 'before';
    const result = await withEnv({ [KEY]: 'during' }, async () => {
      expect(process.env[KEY]).toBe('during');
      await new Promise(r => setTimeout(r, 5));
      expect(process.env[KEY]).toBe('during');
      return 'done';
    });
    expect(result).toBe('done');
    expect(process.env[KEY]).toBe('before');
    delete process.env[KEY];
  });

  test('delete-key: undefined override removes the var, restores it after', async () => {
    process.env[KEY] = 'will-be-deleted';
    await withEnv({ [KEY]: undefined }, () => {
      expect(process.env[KEY]).toBeUndefined();
    });
    expect(process.env[KEY]).toBe('will-be-deleted');
    delete process.env[KEY];
  });

  test('delete-key when prior was unset: stays unset after restore', async () => {
    delete process.env[KEY];
    await withEnv({ [KEY]: 'temp' }, () => {
      expect(process.env[KEY]).toBe('temp');
    });
    expect(process.env[KEY]).toBeUndefined();
  });

  test('restore-on-throw: callback throws, env still restored', async () => {
    process.env[KEY] = 'safe';
    let caught: unknown = null;
    try {
      await withEnv({ [KEY]: 'wreckage' }, () => {
        expect(process.env[KEY]).toBe('wreckage');
        throw new Error('boom');
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe('boom');
    expect(process.env[KEY]).toBe('safe');
    delete process.env[KEY];
  });

  test('nested compose: inner overrides outer, restore returns to outer value', async () => {
    delete process.env[KEY];
    await withEnv({ [KEY]: 'outer' }, async () => {
      expect(process.env[KEY]).toBe('outer');
      await withEnv({ [KEY]: 'inner' }, () => {
        expect(process.env[KEY]).toBe('inner');
      });
      expect(process.env[KEY]).toBe('outer');
    });
    expect(process.env[KEY]).toBeUndefined();
  });

  test('multiple keys: sets and restores all atomically', async () => {
    process.env[KEY] = 'A-prior';
    delete process.env[KEY2];
    await withEnv({ [KEY]: 'A-new', [KEY2]: 'B-new' }, () => {
      expect(process.env[KEY]).toBe('A-new');
      expect(process.env[KEY2]).toBe('B-new');
    });
    expect(process.env[KEY]).toBe('A-prior');
    expect(process.env[KEY2]).toBeUndefined();
    delete process.env[KEY];
  });
});

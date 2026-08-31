// Prior env state is established through withEnv (R1: no direct process.env
// assignment in non-serial files); the helpers under test run inside it.
import { describe, test, expect } from 'bun:test';
import { withEnv } from './with-env.ts';
import { withColdPglite, withSnapshotValue } from './with-snapshot.ts';

const KEY = 'GBRAIN_PGLITE_SNAPSHOT';

describe('withColdPglite', () => {
  test('restore-on-success: snapshot cleared during fn, prior value back after', async () => {
    await withEnv({ [KEY]: '/tmp/snap.tar' }, async () => {
      const result = await withColdPglite(async () => {
        expect(process.env[KEY]).toBeUndefined();
        return 7;
      });
      expect(result).toBe(7);
      expect(process.env[KEY]).toBe('/tmp/snap.tar');
    });
  });

  test('restore-on-throw: fn throws, prior value still restored', async () => {
    await withEnv({ [KEY]: '/tmp/snap.tar' }, async () => {
      let caught: unknown = null;
      try {
        await withColdPglite(async () => {
          expect(process.env[KEY]).toBeUndefined();
          throw new Error('boom');
        });
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toBe('boom');
      expect(process.env[KEY]).toBe('/tmp/snap.tar');
    });
  });

  test('was-undefined restore: stays unset after fn, never becomes ""', async () => {
    await withEnv({ [KEY]: undefined }, async () => {
      await withColdPglite(async () => {
        expect(process.env[KEY]).toBeUndefined();
      });
      expect(process.env[KEY]).toBeUndefined();
    });
  });
});

describe('withSnapshotValue', () => {
  test('sets the given value for the duration of fn', async () => {
    await withEnv({ [KEY]: undefined }, async () => {
      await withSnapshotValue('/tmp/other.tar', async () => {
        expect(process.env[KEY]).toBe('/tmp/other.tar');
      });
      expect(process.env[KEY]).toBeUndefined();
    });
  });

  test('nesting: inner restores to outer value, not the original', async () => {
    await withEnv({ [KEY]: '/tmp/original.tar' }, async () => {
      await withSnapshotValue('/tmp/outer.tar', async () => {
        expect(process.env[KEY]).toBe('/tmp/outer.tar');
        await withColdPglite(async () => {
          expect(process.env[KEY]).toBeUndefined();
        });
        expect(process.env[KEY]).toBe('/tmp/outer.tar');
      });
      expect(process.env[KEY]).toBe('/tmp/original.tar');
    });
  });
});

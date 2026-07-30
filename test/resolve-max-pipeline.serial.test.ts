import { describe, expect, test } from 'bun:test';
import { resolveMaxPipeline } from '../src/core/db.ts';
import { withEnv } from './helpers/with-env.ts';

describe('resolveMaxPipeline', () => {
  test('bounds transaction-pooler traffic when prepare is disabled', async () => {
    await withEnv({ GBRAIN_MAX_PIPELINE: undefined }, () => {
      expect(resolveMaxPipeline('postgresql://user:pass@host:6543/db', false)).toBe(1);
    });
  });

  test('leaves direct Postgres on the driver default', async () => {
    await withEnv({ GBRAIN_MAX_PIPELINE: undefined }, () => {
      expect(resolveMaxPipeline('postgresql://user:pass@host:5432/db', true)).toBeUndefined();
      expect(resolveMaxPipeline('postgresql://user:pass@host:5432/db', undefined)).toBeUndefined();
    });
  });

  test('allows an explicit environment override', async () => {
    await withEnv({ GBRAIN_MAX_PIPELINE: '7' }, () => {
      expect(resolveMaxPipeline('postgresql://user:pass@host:6543/db?max_pipeline=4', false)).toBe(7);
    });
  });

  test('allows an explicit URL override', async () => {
    await withEnv({ GBRAIN_MAX_PIPELINE: undefined }, () => {
      expect(resolveMaxPipeline(
        'postgresql://user:pass@host:6543/db?max_pipeline=4',
        false,
      )).toBe(4);
    });
  });

  test('keeps the safe transaction-pooler fallback for invalid overrides', async () => {
    await withEnv({ GBRAIN_MAX_PIPELINE: '0' }, () => {
      expect(resolveMaxPipeline('postgresql://user:pass@host:6543/db', false)).toBe(1);
    });
    await withEnv({ GBRAIN_MAX_PIPELINE: 'not-a-number' }, () => {
      expect(resolveMaxPipeline('postgresql://user:pass@host:6543/db', false)).toBe(1);
    });
  });
});

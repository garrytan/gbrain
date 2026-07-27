import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  reserve,
  settle,
  sweepExpiredReservations,
  getClientDailyCapCents,
  clientLockKey,
  BudgetExceededError,
  RESERVATION_TTL_MS,
} from '../../src/core/minions/budget-meter.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedClient(clientId: string, capUsd: number | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types, redirect_uris, token_endpoint_auth_method, budget_usd_per_day, created_at, deleted_at)
     VALUES ($1, $1, '', 'agent', ARRAY['client_credentials'], ARRAY[]::text[], 'client_secret_post', $2, now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET budget_usd_per_day = EXCLUDED.budget_usd_per_day`,
    [clientId, capUsd],
  );
}

describe('minions/budget-meter (v0.38 Slice 2 — D3 reserve-then-settle)', () => {
  describe('clientLockKey (FNV-1a determinism)', () => {
    it('returns the same int for the same client_id', () => {
      expect(clientLockKey('client-a')).toBe(clientLockKey('client-a'));
    });
    it('returns different ints for different client_ids', () => {
      expect(clientLockKey('client-a')).not.toBe(clientLockKey('client-b'));
    });
    it('output fits in positive INT32', () => {
      const k = clientLockKey('any-client-id-with-some-length');
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(2 ** 32);
    });
  });

  describe('reserve()', () => {
    it('passes when projected total ≤ cap', async () => {
      await seedClient('alice', 5.00);
      const r = await reserve(engine, {
        clientId: 'alice',
        estimatedCents: 100,
        capCents: 500,
        model: 'anthropic:claude-sonnet-4-6',
        provider: 'anthropic',
      });
      expect(r.reservationId).toMatch(/^[0-9a-f-]+$/i);
      expect(r.estimatedCents).toBe(100);
      expect(r.ttlMs).toBe(RESERVATION_TTL_MS);
    });

    it('refuses with BudgetExceededError when projected > cap', async () => {
      await seedClient('alice', 1.00);
      await expect(
        reserve(engine, {
          clientId: 'alice', estimatedCents: 200, capCents: 100,
          model: 'm', provider: 'p',
        }),
      ).rejects.toThrow(BudgetExceededError);
    });

    it('two sequential reserves both succeed when under cap', async () => {
      await seedClient('alice', 5.00);
      const r1 = await reserve(engine, {
        clientId: 'alice', estimatedCents: 100, capCents: 500,
        model: 'm', provider: 'p',
      });
      const r2 = await reserve(engine, {
        clientId: 'alice', estimatedCents: 100, capCents: 500,
        model: 'm', provider: 'p',
      });
      expect(r1.reservationId).not.toBe(r2.reservationId);
    });

    it('refuses second reserve when pending sum pushes over cap', async () => {
      await seedClient('alice', 1.00);
      await reserve(engine, {
        clientId: 'alice', estimatedCents: 80, capCents: 100,
        model: 'm', provider: 'p',
      });
      await expect(
        reserve(engine, {
          clientId: 'alice', estimatedCents: 80, capCents: 100,
          model: 'm', provider: 'p',
        }),
      ).rejects.toThrow(BudgetExceededError);
    });

    it('admits only cap-fitting reservations under concurrent pressure', async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () => reserve(engine, {
          clientId: 'alice', estimatedCents: 20, capCents: 100,
          model: 'm', provider: 'p',
        })),
      );
      const fulfilled = attempts.filter(r => r.status === 'fulfilled');
      const rejected = attempts.filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(5);
      expect(rejected).toHaveLength(5);
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
      }

      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT COALESCE(SUM(estimated_cents), 0)::text AS total
           FROM mcp_spend_reservations
          WHERE client_id = 'alice' AND status = 'pending'`,
      );
      expect(Number(rows[0]?.total)).toBe(100);
    });

    it('rejects invalid numeric input before opening a transaction', async () => {
      await expect(reserve(engine, {
        clientId: 'alice', estimatedCents: Number.NaN, capCents: 100,
        model: 'm', provider: 'p',
      })).rejects.toThrow(TypeError);
    });
  });

  describe('settle()', () => {
    it('marks settled and writes to mcp_spend_log', async () => {
      await seedClient('alice', 5.00);
      const r = await reserve(engine, {
        clientId: 'alice', estimatedCents: 100, capCents: 500,
        model: 'anthropic:sonnet', provider: 'anthropic',
      });
      await settle(engine, r.reservationId, 75);
      const reservationRows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT status, actual_cents::text AS a FROM mcp_spend_reservations WHERE reservation_id = $1`,
        [r.reservationId],
      );
      expect(reservationRows[0]?.status).toBe('settled');
      expect(parseFloat(String(reservationRows[0]?.a))).toBe(75);
      const logRows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT spend_cents::text AS s FROM mcp_spend_log WHERE client_id = $1`,
        ['alice'],
      );
      expect(logRows.length).toBe(1);
      expect(parseFloat(String(logRows[0]?.s))).toBe(75);
    });

    it('second settle on same reservation is no-op', async () => {
      await seedClient('alice', 5.00);
      const r = await reserve(engine, {
        clientId: 'alice', estimatedCents: 100, capCents: 500,
        model: 'm', provider: 'p',
      });
      await settle(engine, r.reservationId, 50);
      await settle(engine, r.reservationId, 99);
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT actual_cents::text AS a FROM mcp_spend_reservations WHERE reservation_id = $1`,
        [r.reservationId],
      );
      expect(parseFloat(String(rows[0]?.a))).toBe(50);
      const logCount = await engine.executeRaw<Record<string, unknown>>(
        `SELECT count(*)::int AS n FROM mcp_spend_log WHERE client_id = $1`,
        ['alice'],
      );
      expect(Number(logCount[0]?.n)).toBe(1);
    });

    it('rolls reservation state back when the spend-log insert fails', async () => {
      const r = await reserve(engine, {
        clientId: 'alice', estimatedCents: 100, capCents: 500,
        model: 'm', provider: 'p',
      });

      const failingEngine = Object.create(engine) as PGLiteEngine;
      Object.defineProperty(failingEngine, 'transaction', {
        value: <T>(fn: (tx: PGLiteEngine) => Promise<T>) => engine.transaction(async tx => {
          const failingTx = Object.create(tx) as PGLiteEngine;
          Object.defineProperty(failingTx, 'executeRaw', {
            value: async (query: string, params?: unknown[]) => {
              if (/INSERT\s+INTO\s+mcp_spend_log/i.test(query)) {
                throw new Error('injected spend-log write failure');
              }
              return tx.executeRaw(query, params);
            },
          });
          return fn(failingTx);
        }),
      });

      await expect(settle(failingEngine, r.reservationId, 75))
        .rejects.toThrow('injected spend-log write failure');
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT status, actual_cents FROM mcp_spend_reservations WHERE reservation_id = $1`,
        [r.reservationId],
      );
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.actual_cents).toBeNull();
    });

    it('preserves OAuth token attribution in the committed spend row', async () => {
      const r = await reserve(engine, {
        clientId: 'alice', estimatedCents: 100, capCents: 500,
        model: 'm', provider: 'p',
      });
      await settle(engine, r.reservationId, 50, 'search_by_image', 'client-token');
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT token_name FROM mcp_spend_log WHERE client_id = 'alice'`,
      );
      expect(rows[0]?.token_name).toBe('client-token');
    });

    it('records a paid result that arrives after the reservation expired', async () => {
      const r = await reserve(engine, {
        clientId: 'alice', estimatedCents: 100, capCents: 500,
        model: 'm', provider: 'p',
      });
      await engine.executeRaw(
        `UPDATE mcp_spend_reservations
            SET status = 'expired', actual_cents = 0
          WHERE reservation_id = $1`,
        [r.reservationId],
      );

      await settle(engine, r.reservationId, 75);
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT status, actual_cents::text AS actual
           FROM mcp_spend_reservations
          WHERE reservation_id = $1`,
        [r.reservationId],
      );
      expect(rows[0]?.status).toBe('settled');
      expect(Number(rows[0]?.actual)).toBe(75);
      const logs = await engine.executeRaw<Record<string, unknown>>(
        `SELECT COALESCE(SUM(spend_cents), 0)::text AS total
           FROM mcp_spend_log
          WHERE client_id = 'alice'`,
      );
      expect(Number(logs[0]?.total)).toBe(75);
    });

    it('fails closed for an unknown reservation id', async () => {
      await expect(settle(engine, '00000000-0000-0000-0000-000000000099', 1))
        .rejects.toThrow('spend reservation not found');
    });
  });

  describe('sweepExpiredReservations()', () => {
    it('marks past-TTL pending rows as expired', async () => {
      await seedClient('alice', 5.00);
      const expired = new Date(Date.now() - 60_000).toISOString();
      await engine.executeRaw(
        `INSERT INTO mcp_spend_reservations
           (reservation_id, client_id, estimated_cents, model, provider, status, expires_at)
         VALUES ('00000000-0000-0000-0000-000000000001', 'alice', 50, 'm', 'p', 'pending', $1)`,
        [expired],
      );
      const n = await sweepExpiredReservations(engine);
      expect(n).toBe(1);
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT status FROM mcp_spend_reservations WHERE reservation_id = '00000000-0000-0000-0000-000000000001'`,
      );
      expect(rows[0]?.status).toBe('expired');
    });

    it('leaves fresh pending rows alone', async () => {
      await seedClient('alice', 5.00);
      const r = await reserve(engine, {
        clientId: 'alice', estimatedCents: 50, capCents: 500,
        model: 'm', provider: 'p',
      });
      const n = await sweepExpiredReservations(engine);
      expect(n).toBe(0);
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT status FROM mcp_spend_reservations WHERE reservation_id = $1`,
        [r.reservationId],
      );
      expect(rows[0]?.status).toBe('pending');
    });
  });

  describe('getClientDailyCapCents()', () => {
    it('returns cap in cents when set', async () => {
      await seedClient('alice', 5.00);
      expect(await getClientDailyCapCents(engine, 'alice')).toBe(500);
    });
    it('returns null when unset', async () => {
      await seedClient('bob', null);
      expect(await getClientDailyCapCents(engine, 'bob')).toBe(null);
    });
    it('returns null for unknown client', async () => {
      expect(await getClientDailyCapCents(engine, 'nobody')).toBe(null);
    });
    it('fails closed when the accounting read fails', async () => {
      const unavailable = Object.create(engine) as PGLiteEngine;
      Object.defineProperty(unavailable, 'executeRaw', {
        value: async () => { throw new Error('accounting unavailable'); },
      });
      await expect(getClientDailyCapCents(unavailable, 'alice'))
        .rejects.toThrow('accounting unavailable');
    });
  });

  describe('committed spend feeds next reserve', () => {
    it('settled spend pushes the next reserve over cap', async () => {
      await seedClient('alice', 1.00);
      const r1 = await reserve(engine, {
        clientId: 'alice', estimatedCents: 60, capCents: 100,
        model: 'm', provider: 'p',
      });
      await settle(engine, r1.reservationId, 55);
      await expect(
        reserve(engine, {
          clientId: 'alice', estimatedCents: 50, capCents: 100,
          model: 'm', provider: 'p',
        }),
      ).rejects.toThrow(BudgetExceededError);
    });
  });
});

/**
 * `enrich --background` asks for consent before it queues paid jobs.
 *
 * Protects: a non-TTY agent cannot queue paid `enrich` Minion jobs without an
 * authorization (`--yes`, `--max-usd`, a preapproval or tokenmax). Regression
 * that fails it: the background branch queueing before the consent gate runs.
 * Existing coverage gates only the inline path.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnrich } from '../src/commands/enrich.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { withEnv } from './helpers/with-env.ts';
import { stubSourceMembers } from './helpers/source-members-stub.ts';
import type { SpendAuthorization } from '../src/core/minions/spend-authorization.ts';

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

function fakePostgres(sourceIds: string[]) {
  return {
    kind: 'postgres',
    getConfig: async () => null,
    ...stubSourceMembers(sourceIds.map(id => ({ id }))),
    executeRaw: async () => [{ n: 0 }],
  } as never;
}

let home: string;
let added: Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> | undefined; trusted: { spendAuthorization?: SpendAuthorization } | undefined }>;
let out: string[];
let spies: Array<{ mockRestore(): void }>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-enrich-bg-consent-'));
  added = [];
  out = [];
  let nextId = 1;
  spies = [
    spyOn(MinionQueue.prototype, 'add').mockImplementation((async (name: string, data: Record<string, unknown>, opts?: Record<string, unknown>, trusted?: { spendAuthorization?: SpendAuthorization }) => {
      added.push({ name, data, opts, trusted });
      return { id: nextId++, status: 'waiting', spend_authorization: trusted?.spendAuthorization ?? null };
    }) as never),
    spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never),
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out.push(String(chunk)); return true; }) as never),
    spyOn(process.stderr, 'write').mockImplementation((() => true) as never),
    spyOn(console, 'log').mockImplementation(((...a: unknown[]) => { out.push(a.join(' ')); }) as never),
  ];
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

async function run(sources: string[], args: string[]): Promise<number | null> {
  return withEnv({ GBRAIN_HOME: home, GBRAIN_INTERACTIVE: undefined }, async () => {
    try {
      await runEnrich(fakePostgres(sources), args);
      return null;
    } catch (e) {
      if (e instanceof Exit) return e.code;
      throw e;
    }
  });
}

describe('enrich --background consent', () => {
  test('single source without --yes exits 3 and queues nothing', async () => {
    expect(await run(['default'], ['--background', '--json'])).toBe(3);
    expect(added).toEqual([]);
    const payload = JSON.parse(out.join(''));
    expect(payload.code).toBe('confirmation_required');
    expect(payload.est_usd).toBe(0.5);
    expect(payload.fix.argv).toEqual(['gbrain', 'enrich', '--background', '--json', '--max-usd', '0.75', '--yes']);
    expect(payload.preview.argv).toEqual(['gbrain', 'enrich', '--dry-run']);
  });

  test('several sources without --yes exit 3 and queue nothing', async () => {
    expect(await run(['default', 'wiki'], ['--background', '--json'])).toBe(3);
    expect(added).toEqual([]);
    expect(JSON.parse(out.join('')).est_usd).toBe(1);
  });

  test('--yes queues one job per source, all under one authorized group', async () => {
    expect(await run(['default', 'wiki'], ['--background', '--yes'])).toBeNull();
    expect(added.map(a => [a.name, a.data.sourceId])).toEqual([['enrich', 'default'], ['enrich', 'wiki']]);
    const records = added.map(a => a.trusted?.spendAuthorization);
    expect(records[0]).toMatchObject({ kind: 'authorized', of: 2, cap_usd: 1.5, cap_source: 'derived', est_usd: 1, command: 'enrich',
      argv: ['gbrain', 'enrich', '--background'] });
    expect(records[1]!.group_id).toBe(records[0]!.group_id);
    expect(added.every(a => !('spend_authorization' in a.data))).toBe(true);
  });

  test('a single source carries its record through the background submit', async () => {
    expect(await run(['default'], ['--background', '--max-usd', '3'])).toBeNull();
    expect(added[0]!.trusted?.spendAuthorization).toMatchObject({ kind: 'authorized', of: 1, cap_usd: 3, cap_source: 'user', via: 'max_usd' });
    expect(added[0]!.opts?.idempotency_key).toMatch(/^cli:enrich:/);
  });

  test('--max-usd off is itself the authorization and stores an uncapped record', async () => {
    expect(await run(['default', 'wiki'], ['--background', '--max-usd', 'off'])).toBeNull();
    expect(added[0]!.trusted?.spendAuthorization).toMatchObject({ cap_usd: null, uncapped: true, via: 'max_usd' });
  });

  test('--dry-run queues without consent', async () => {
    expect(await run(['default'], ['--background', '--dry-run'])).toBeNull();
    expect(added.map(a => a.data.dryRun)).toEqual([true]);
    expect(added[0]!.trusted).toBeUndefined();
  });
});

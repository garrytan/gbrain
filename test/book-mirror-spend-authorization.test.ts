/**
 * book-mirror stores the user's approval on every chapter subagent it queues.
 *
 * Protects: the approved total reaches the worker (one group shared by all
 * children, `of` = chapters), and a rerun reports the kept authorization of
 * still-queued children with the cancel-and-resubmit commands. Regression
 * that fails it: the consent Authorization discarded before submission.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { prepareBookMirrorPublication, runBookMirrorCmd } from '../src/commands/book-mirror.ts';
import { operations } from '../src/core/operations.ts';
import { parseSpendAuthorization } from '../src/core/minions/spend-authorization.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-book-mirror-spend-'));
  writeFileSync(join(dir, '01-one.txt'), 'Chapter one text about patience and long games.');
  writeFileSync(join(dir, '02-two.txt'), 'Chapter two text about compounding small advantages.');
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<string> {
  const err: string[] = [];
  const spies = [
    spyOn(process.stderr, 'write').mockImplementation(((c: string) => { err.push(String(c)); return true; }) as never),
    spyOn(process.stdout, 'write').mockImplementation((() => true) as never),
  ];
  try {
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_INTERACTIVE: undefined }, () => runBookMirrorCmd(engine, args));
  } finally { for (const s of spies) s.mockRestore(); }
  return err.join('');
}

describe('book-mirror spend authorization', () => {
  test('every child row carries the authorization and the same group', async () => {
    const stderr = await run(['--chapters-dir', dir, '--slug', 'a-book', '--model', 'anthropic:claude-opus-4-7', '--yes']);
    const rows = await engine.executeRaw<{ spend_authorization: unknown; data: unknown }>(
      `SELECT spend_authorization, data FROM minion_jobs WHERE name = 'subagent' ORDER BY id`);
    expect(rows).toHaveLength(2);
    const records = rows.map(r => parseSpendAuthorization(r.spend_authorization)!);
    expect(new Set(records.map(r => r.group_id)).size).toBe(1);
    expect(records[0]).toMatchObject({ kind: 'authorized', of: 2, command: 'book-mirror', cap_source: 'derived', via: 'yes' });
    expect(records[0]!.argv).toEqual(['gbrain', 'book-mirror', '--chapters-dir', dir, '--slug', 'a-book', '--model', 'anthropic:claude-opus-4-7']);
    expect(JSON.stringify(rows[0]!.data)).not.toContain('spend_authorization');
    expect(stderr).toContain(`under group ${records[0]!.group_id}`);
  });

  test('a rerun keeps queued children on their authorization and names the cancel-and-resubmit commands', async () => {
    const [{ group_id }] = await engine.executeRaw<{ group_id: string }>(
      `SELECT spend_authorization->>'group_id' AS group_id FROM minion_jobs WHERE name = 'subagent' LIMIT 1`);
    const stderr = await run(['--chapters-dir', dir, '--slug', 'a-book', '--model', 'anthropic:claude-opus-4-7', '--max-usd', '20']);
    expect(stderr).toContain(`keep their earlier authorization: group ${group_id}`);
    expect(stderr).toContain(`foresights jobs cancel --group ${group_id}`);
    const groups = await engine.executeRaw<{ g: string }>(`SELECT DISTINCT spend_authorization->>'group_id' AS g FROM minion_jobs`);
    expect(groups).toEqual([{ g: group_id }]);
  });
});

describe('book-mirror publication refusals name their next step', () => {
  const putPage = operations.find(op => op.name === 'put_page')!;
  const publishWith = async (receipt: unknown) => {
    const spy = spyOn(putPage, 'handler').mockImplementation((async () => receipt) as never);
    try {
      const publish = await prepareBookMirrorPublication(engine, 'media/books/z-book-personalized');
      return await publish('# Z').then(() => null, (e: unknown) => e as Record<string, any>);
    } finally { spy.mockRestore(); }
  };

  test('a pending receipt refuses with the read-only write-request fix', async () => {
    const err = (await publishWith({ request_id: '0192a000-0000-7000-8000-000000000009', state: 'queued', retry_after_ms: 500 }))!;
    expect(err.code).toBe('write_pending');
    expect(err.fix).toMatchObject({ argv: ['gbrain', 'write-request', '--', expect.any(String)], consent: [] });
    expect(err.suggestion).toContain('foresights write-request --');
    expect(err.writeRequest).toMatchObject({ state: 'queued' });
  });

  test('a missing receipt refuses with a read of the page', async () => {
    const err = (await publishWith({ ok: true }))!;
    expect(err.code).toBe('storage_error');
    expect(err.fix).toMatchObject({ argv: ['gbrain', 'get', '--source', 'default', '--', 'media/books/z-book-personalized'], consent: [] });
  });
});


/**
 * A reserved transaction's body starts after BEGIN's answer on a pool that does not pipeline (`max_pipeline` 0, a
 * transaction-mode pooler). A pooler can refuse a BEGIN and answer the statements behind it in autocommit, so a body sent
 * with BEGIN could commit its writes outside the transaction. Elsewhere BEGIN still goes out with the body.
 */
import { describe, expect, test } from 'bun:test';
import type postgres from '#postgres';
import { reservedTransactions } from '../src/core/postgres-engine/reserved-transactions.ts';
import { READ_WRITE_BEGIN } from '../src/core/postgres-engine/read-write-transactions.ts';

/** A reserved connection that records each statement with whether BEGIN had been answered when it was sent. */
function fakeReserved(maxPipeline: number, beginFails: boolean) {
  const sent: Array<{ text: string; beginAnswered: boolean }> = [];
  let beginAnswered = false;
  const statement = (text: string) => {
    sent.push({ text, beginAnswered });
    const result: Promise<unknown> = text === READ_WRITE_BEGIN
      ? new Promise((resolve, reject) => setTimeout(() => {
          beginAnswered = true;
          beginFails ? reject(Object.assign(new Error('no server connection available'), { code: '08P01' })) : resolve(Object.assign([], { command: 'BEGIN' }));
        }, 20))
      : Promise.resolve(Object.assign([], { command: text.toUpperCase() }));
    result.catch(() => undefined);
    return Object.assign(result, { execute: () => result });
  };
  const reserved = Object.assign((strings: TemplateStringsArray) => statement(strings.join('')), {
    unsafe: statement, options: { max_pipeline: maxPipeline }, discard: () => undefined,
  }) as unknown as postgres.ReservedSql;
  return { reserved, sent };
}

const begin = (reserved: postgres.ReservedSql) => (reservedTransactions(reserved) as unknown as { begin(fn: typeof body): Promise<string> }).begin(body);
const body = async (sql: { unsafe(text: string): Promise<unknown> }) => { await sql.unsafe('insert into t values (1)'); return 'ok'; };

describe('reserved transactions and BEGIN', () => {
  test('on a non-pipelining pool a refused BEGIN sends none of the body, so no write runs in autocommit', async () => {
    const { reserved, sent } = fakeReserved(0, true);
    const error = await begin(reserved).then(() => null, (e: { code?: string }) => e.code);
    expect(error).toBe('08P01');
    expect(sent.map(s => s.text)).not.toContain('insert into t values (1)');
  });

  test('on a non-pipelining pool the body is sent only after BEGIN is answered', async () => {
    const { reserved, sent } = fakeReserved(0, false);
    expect(await begin(reserved)).toBe('ok');
    expect(sent).toEqual([{ text: READ_WRITE_BEGIN, beginAnswered: false }, { text: 'insert into t values (1)', beginAnswered: true }, { text: 'commit', beginAnswered: true }]);
  });

  test('on a pipelining pool BEGIN still goes out with the body', async () => {
    const { reserved, sent } = fakeReserved(100, false);
    expect(await begin(reserved)).toBe('ok');
    expect(sent.slice(0, 2)).toEqual([{ text: READ_WRITE_BEGIN, beginAnswered: false }, { text: 'insert into t values (1)', beginAnswered: false }]);
  });
});

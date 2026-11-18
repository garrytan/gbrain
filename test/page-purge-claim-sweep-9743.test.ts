/**
 * #9743: the purge's claim sweep lowered every unreferenced segment text once per
 * (text, form) pair inside one DELETE, so a few MB of text outlasted the 5 s statement
 * budget. Each text is now lowered once, in a MATERIALIZED CTE, per chunk of text.
 * The deleted set is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { deletePageWithSegments } from '../src/core/persistence/page-purge.ts';

describe('#9743 claim sweep', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  test('lowers each text once per chunk and deletes the same set', async () => {
    const put = async (text: string) => {
      const body = Buffer.from(text);
      const sha = createHash('sha256').update(body).digest();
      await engine.executeRaw(`INSERT INTO page_segment_texts (source_id,sha256,byte_len,line_count,body) VALUES ('default',$1,$2,1,$3)`, [sha, body.length, body]);
      return sha.toString('hex');
    };
    const hit = await put('A line with the Secret Claim inside');
    const keep = await put('unrelated filler');
    const sqls: string[] = [];
    const spy = new Proxy(engine as BrainEngine, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop !== 'executeRaw') return typeof v === 'function' ? v.bind(target) : v;
        return (sql: string, ...rest: unknown[]) => { sqls.push(sql); return (v as Function).call(target, sql, ...rest); };
      },
    });
    const out = await deletePageWithSegments(spy, 'default', 'no/such-page', -1, ['Secret Claim']);
    const left = (await engine.executeRaw<{ sha: string }>(`SELECT encode(sha256,'hex') AS sha FROM page_segment_texts`)).map(r => r.sha);
    expect(out.shas).toEqual([hit]);
    expect(left).toEqual([keep]);
    const sweeps = sqls.filter(s => s.includes('strpos('));
    expect(sweeps.length).toBeGreaterThan(0);
    expect(sweeps.filter(s => !/MATERIALIZED/.test(s))).toEqual([]);
  });
});

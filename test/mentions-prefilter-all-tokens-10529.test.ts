/**
 * #10529: when a source gains names, the mention pass prefilters pages in SQL before reading their full text. The
 * prefilter matched each name's longest token alone, so a name whose longest word is common ("program") sent most of
 * the brain to the JS scanner. It now requires every token of a name, in order, which is still a superset of what the
 * scanner links (the scanner needs the tokens adjacent and in order). The pages found are unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Gazetteer } from '../src/core/by-mention.ts';
import * as pass from '../src/core/mentions/pass.ts';

let engine: PGLiteEngine;
const ids: Record<string, number> = {};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages: Array<[string, string]> = [
    ['notes/exchange', 'The exchange program ran all year.'],
    ['notes/backwards', 'A program about acme widgets.'],
    ['notes/joined', 'We joined the Acme Program last week.'],
    ['notes/split', 'Acme announced a new\n\nprogram today.'],
    ['notes/zoe', 'Zoë Acme joined the board.'],
  ];
  for (const [slug, body] of pages) {
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ('default', $1, 'note', $1, $2) RETURNING id`, [slug, body]);
    ids[slug] = Number(row!.id);
  }
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

async function prefilter(added: Gazetteer): Promise<{ out: { ids: number[]; through: number | null }; read: string[] }> {
  const pagesMatchingNames = (pass as Record<string, unknown>).pagesMatchingNames as
    ((e: BrainEngine, s: string[], a: Gazetteer, x: boolean, d: number) => Promise<{ ids: number[]; through: number | null }>) | undefined;
  expect(typeof pagesMatchingNames).toBe('function');
  const read: string[] = [];
  const counting = new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
      return async (sql: string, params?: unknown[]) => {
        const rows = await target.executeRaw<{ slug?: string; body?: string | null }>(sql, params);
        for (const r of rows) if (r.body != null && r.slug) read.push(r.slug);
        return rows;
      };
    },
  }) as unknown as BrainEngine;
  const out = await pagesMatchingNames!(counting, ['default'], added, false, Date.now() + 30_000);
  return { out, read: read.sort() };
}

describe('mention pass prefilter (#10529)', () => {
  test('a page holding only the common word of a new name is not read; the matching page still is', async () => {
    const added: Gazetteer = new Map([['acme', [{ slug: 'programs/acme-program', source_id: 'default', title: 'Acme Program', tokens: ['acme', 'program'] }]]]);
    const { out, read } = await prefilter(added);
    expect(out).toEqual({ ids: [ids['notes/joined']!], through: null });
    expect(read).toEqual(['notes/joined', 'notes/split']);
  });

  test('a name with an accented word still prefilters on its ASCII words', async () => {
    const added: Gazetteer = new Map([['zoë', [{ slug: 'people/zoe-acme', source_id: 'default', title: 'Zoë Acme', tokens: ['zoë', 'acme'] }]]]);
    const { out, read } = await prefilter(added);
    expect(out).toEqual({ ids: [ids['notes/zoe']!], through: null });
    expect(read).not.toContain('notes/exchange');
    expect(read).toContain('notes/zoe');
  });
});

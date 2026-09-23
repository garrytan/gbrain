import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { retireSupersededTwins } from '../src/core/sync-twins.ts';

/**
 * Retiring an old-slug twin is two writes — soft-delete the twin, redirect its
 * slug to the page that replaced it. They must land together: a twin deleted
 * without its redirect breaks every link to the old slug, and the row is gone
 * from the next reconcile, so nothing would ever retry it.
 */

let engine: PGLiteEngine;
const SRC = 'default';
const TWIN = { slug: 'wiki/елка', canonical: 'wiki/ёлка' };
const noFiles = () => ({ slugs: new Set<string>(), complete: true });

async function live(slug: string) {
  const [row] = await engine.executeRaw<{ live: boolean }>(
    `SELECT deleted_at IS NULL AS live FROM pages WHERE source_id = $1 AND slug = $2`, [SRC, slug],
  );
  return row?.live;
}
async function redirect(slug: string) {
  const [row] = await engine.executeRaw<{ canonical_slug: string }>(
    `SELECT canonical_slug FROM slug_aliases WHERE source_id = $1 AND alias_slug = $2`, [SRC, slug],
  );
  return row?.canonical_slug;
}

/** The engine, with executeRaw failing for SQL the predicate picks (inside transactions too). */
function failing(pick: (sql: string) => boolean): PGLiteEngine {
  const wrap = (target: PGLiteEngine): PGLiteEngine => new Proxy(target, {
    get(t, key, recv) {
      if (key === 'transaction') {
        return (fn: (tx: PGLiteEngine) => Promise<unknown>) =>
          (Reflect.get(t, key, recv) as Function).call(t, (tx: PGLiteEngine) => fn(wrap(tx)));
      }
      if (key === 'executeRaw') {
        return (sql: string, ...rest: unknown[]) => pick(sql)
          ? Promise.reject(new Error('injected failure'))
          : (Reflect.get(t, key, recv) as Function).call(t, sql, ...rest);
      }
      const v = Reflect.get(t, key, recv);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return wrap(engine);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM slug_aliases`);
  await engine.executeRaw(`DELETE FROM pages`);
  for (const slug of [TWIN.slug, TWIN.canonical]) {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, source_path) VALUES ($1, $2, 'concept', 't', 't', 'wiki/Ёлка.md')`,
      [SRC, slug],
    );
  }
});

describe('retiring an old-slug twin', () => {
  test('soft-deletes the twin and redirects its slug to the page that replaced it', async () => {
    expect(await retireSupersededTwins(engine, SRC, [TWIN], () => {}, noFiles)).toBe(1);
    expect(await live(TWIN.slug)).toBe(false);
    expect(await redirect(TWIN.slug)).toBe(TWIN.canonical);
  });

  test('a failed redirect write leaves the twin live and says so, so the next full sync retries it', async () => {
    const lines: string[] = [];
    const retired = await retireSupersededTwins(
      failing((sql) => /INSERT INTO slug_aliases/i.test(sql)), SRC, [TWIN], (l) => lines.push(l), noFiles,
    );
    expect(retired).toBe(0);
    expect(await live(TWIN.slug)).toBe(true);
    expect(lines.join('\n')).toContain(TWIN.slug);
  });

  test('a redirect the owner already set for the old slug is kept', async () => {
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, 'wiki/manual')`, [SRC, TWIN.slug],
    );
    expect(await retireSupersededTwins(engine, SRC, [TWIN], () => {}, noFiles)).toBe(1);
    expect(await live(TWIN.slug)).toBe(false);
    expect(await redirect(TWIN.slug)).toBe('wiki/manual');
  });
});

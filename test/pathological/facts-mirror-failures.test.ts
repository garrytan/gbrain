/**
 * B-21 / D-2 / D-3: a failed cache mirror does not discard an otherwise safe fence publication.
 * Protects: file/fact publication survives unexpected mirror failures, including real SQL errors and errors after
 * a body update; the failed mirror and its history roll back. Drift still holds publication, and run errors throw.
 * Fails when: the mirror shares the publication transaction without a savepoint, or its failure bypasses drift checks.
 * Existing B-21 coverage pins the warning and inserted count on PGLite, not rollback, file bytes or Postgres recovery.
 * Seams: transaction-preserving engine proxy injects refreshPageBody failures; real isolated PGLite/Postgres engines.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { CLAIM, EDIT, SLUG, withFactsBrain } from './facts-overwrite-fixture.ts';
import { pathologicalArms, runScopedErrors } from './harness.ts';

function brokenMirror(engine: BrainEngine, fail: (tx: BrainEngine, args: Parameters<BrainEngine['refreshPageBody']>) => Promise<never>, afterInsert?: () => Promise<void>): BrainEngine {
  const wrap = (base: BrainEngine): BrainEngine => new Proxy(base, { get(target, prop) {
    if (prop === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>, opts?: Parameters<BrainEngine['transaction']>[1]) =>
      target.transaction(tx => run(wrap(tx)), opts);
    if (prop === 'refreshPageBody') return (...args: Parameters<BrainEngine['refreshPageBody']>) => fail(target, args);
    if (prop === 'insertFacts' && afterInsert) return async (...args: Parameters<BrainEngine['insertFacts']>) => {
      const result = await target.insertFacts(...args);
      await afterInsert();
      return result;
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return wrap(engine);
}

for (const { backend, databaseUrl } of pathologicalArms()) describe(`best-effort facts mirror (${backend})`, () => {
  if (backend === 'postgres') test('the preimage row lock survives rollback of the failed mirror savepoint', async () => {
    await withFactsBrain(databaseUrl, async b => {
      const before = await b.body();
      let checked = false;
      const broken = brokenMirror(b.engine, async () => { throw new Error('mirror write failed'); }, async () => {
        checked = true;
        await expect(b.engine.transaction(async other => {
          await other.executeRaw("SET LOCAL lock_timeout = '100ms'");
          await other.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || $2 WHERE source_id = 'default' AND slug = $1", [SLUG, EDIT]);
        })).rejects.toMatchObject({ code: '55P03' });
      });
      expect((await b.append(broken)).inserted).toBe(1);
      expect(checked).toBe(true);
      expect(await b.body()).toBe(before);
      expect(parseFactsFence(b.bytes()).facts.map(f => f.claim)).toEqual([CLAIM]);
    });
  }, 180_000);

  for (const writer of ['append', 'forget'] as const) {
    for (const failure of ['before', 'after', 'sql'] as const) test(`${writer}: ${failure} mirror failure keeps the canonical fence and fact publication`, async () => {
      await withFactsBrain(databaseUrl, async b => {
        const id = writer === 'forget' ? (await b.append()).ids[0]! : null;
        const before = { body: await b.body(), versions: await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id') };
        const broken = brokenMirror(b.engine, async (tx, args) => {
          if (failure === 'after') await tx.refreshPageBody(...args);
          if (failure === 'sql') await tx.executeRaw("SELECT 'mirror write failed'::integer");
          throw new Error('mirror write failed');
        });
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          if (writer === 'append') expect(await b.append(broken)).toMatchObject({ inserted: 1 });
          else expect(await forgetFactInFence(broken, id!)).toMatchObject({ ok: true, path: 'fence' });
          expect(parseFactsFence(b.bytes()).facts.map(f => ({ claim: f.claim, active: f.active })))
            .toEqual([{ claim: CLAIM, active: writer === 'append' }]);
          expect(await b.engine.executeRaw('SELECT fact FROM facts WHERE expired_at IS NULL'))
            .toEqual(writer === 'append' ? [{ fact: CLAIM }] : []);
          expect(await b.body()).toBe(before.body);
          expect(await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id')).toEqual(before.versions);
          expect(warn.mock.calls.some(c => String(c[0]).includes('FACTS_PAGE_MIRROR_FAILED') && String(c[0]).includes('mirror write failed'))).toBe(true);
        } finally { warn.mockRestore(); }
      });
    }, 180_000);

    test(`${writer}: an editor save during a failed mirror still holds publication`, async () => {
      await withFactsBrain(databaseUrl, async b => {
        const id = writer === 'forget' ? (await b.append()).ids[0]! : null;
        const before = { file: b.bytes(), body: await b.body(), versions: await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id') };
        const broken = brokenMirror(b.engine, async () => { b.fileEdit(); throw new Error('mirror write failed'); });
        const result = writer === 'append' ? await b.append(broken) : await forgetFactInFence(broken, id!);
        expect(result.warning).toContain(`${SLUG} (file_database_drift`);
        expect(result).toMatchObject(writer === 'append' ? { inserted: 0, legacyFallback: true } : { ok: true, path: 'legacy_db' });
        expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: before.file + EDIT, body: before.body });
        expect(await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id')).toEqual(before.versions);
        expect(await b.engine.executeRaw('SELECT fact FROM facts WHERE expired_at IS NULL')).toEqual([]);
      });
    }, 180_000);

    test(`${writer}: run-scoped mirror failures still throw without publishing`, async () => {
      for (const fault of runScopedErrors()) await withFactsBrain(databaseUrl, async b => {
        const id = writer === 'forget' ? (await b.append()).ids[0]! : null;
        const before = { file: b.bytes(), body: await b.body(), versions: await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id') };
        const broken = brokenMirror(b.engine, async () => { throw fault.error(); });
        await expect(writer === 'append' ? b.append(broken) : forgetFactInFence(broken, id!)).rejects.toThrow();
        expect({ file: b.bytes(), body: await b.body() }).toEqual({ file: before.file, body: before.body });
        expect(await b.engine.executeRaw('SELECT id FROM page_versions ORDER BY id')).toEqual(before.versions);
        expect(await b.engine.executeRaw('SELECT fact FROM facts WHERE expired_at IS NULL')).toEqual([]);
      });
    }, 180_000);
  }
});

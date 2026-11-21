/**
 * GST-3032: engine graduation (PGLite to Postgres) copies owner_only_marks rows without firing the delete triggers, and a
 * data copy carries no held flag (a comment on the table). A brain whose owner-only source was removed before it
 * graduates still guards the rows derived from it on the target: the flag is set and a derived row reads owner-only.
 * Fails when: the target's flag is unset after graduation, or the derived page reads as open there.
 * Run: DATABASE_URL=... bun test test/e2e/graduation-owner-only-marks.test.ts
 */
import { describe, expect } from 'bun:test';
import { DATABASE_URL, gbrain, graduationTest } from '../helpers/graduation-e2e.ts';
import { useGraduationCases } from '../helpers/graduation-cli-cases.ts';
import { planAndRun, withSource, withTarget } from '../helpers/graduation-scenarios.ts';
import { deleteSourceRow } from '../../src/core/source-delete.ts';

const { fresh } = useGraduationCases();

describe.skipIf(!DATABASE_URL)('graduation keeps owner-only marks guarded', () => {
  graduationTest('a brain whose iMessage source was removed graduates with the held flag set and the derived page owner-only', async () => {
    const c = await fresh('owner-only-marks');
    const derived = await withSource(c.fx, async engine => {
      await engine.initSchema();
      // The legacy fixture is a managed brain: open its topology and write guards for this session, as writer administration does.
      await engine.executeRaw(`SELECT set_config('gbrain.topology_change', 'on', false), set_config('gbrain.write_sources', '["messages-g","default"]', false)`);
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('messages-g', 'messages-g', '{"kind":"imessage"}'::jsonb)`);
      const insert = async (slug: string, src: string) => String((await engine.executeRaw<{ id: number }>(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1, $2, 'note', $2, 'Harbor ledger notes.') RETURNING id`, [src, slug]))[0]!.id);
      const [chat, page] = [await insert('imessage/chat/2026-06-14', 'messages-g'), await insert('notes/from-chat-g', 'default')];
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('pages', $1, 'pages', $2, 'default')`, [page, chat]);
      await deleteSourceRow(engine, 'messages-g');
      const [state] = await engine.executeRaw<{ held: boolean; owner_only: boolean; sources: number }>(
        `SELECT gbrain_owner_only_held() AS held, gbrain_owner_only_lineage('pages', $1::bigint) AS owner_only,
                (SELECT count(*)::int FROM sources WHERE config->>'kind' = 'imessage') AS sources`, [page]);
      expect(state).toEqual({ held: true, owner_only: true, sources: 0 });
      return page;
    });
    const { argv, env } = await planAndRun(c);
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    const target = await withTarget(c.target.url, engine => engine.executeRaw<{ held: boolean; guard: boolean; owner_only: boolean; marks: number }>(
      `SELECT gbrain_owner_only_held() AS held, gbrain_owner_only_lineage() AS guard, gbrain_owner_only_lineage('pages', $1::bigint) AS owner_only,
              (SELECT count(*)::int FROM owner_only_marks) AS marks`, [derived]));
    expect(target[0]!.marks).toBeGreaterThan(0);
    expect({ held: target[0]!.held, guard: target[0]!.guard, owner_only: target[0]!.owner_only }).toEqual({ held: true, guard: true, owner_only: true });
  }, 1_200_000);
});

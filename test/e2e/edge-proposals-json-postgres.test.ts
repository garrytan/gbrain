/**
 * #6193: on Postgres `link_edge_proposals.id` is BIGSERIAL and the driver
 * returns it as BigInt; `edge-proposals list --json` and `show <id> --json`
 * must print one parseable document with a numeric id (the form `show` takes).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

const describeDatabase = hasDatabase() ? describe : describe.skip;

describeDatabase('#6193 edge-proposals --json on Postgres BigInt ids', () => {
  let engine: PostgresEngine;
  let home: string;
  let proposalId: number;

  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw('DELETE FROM link_edge_proposals');
    for (const slug of ['people/alice-example', 'companies/acme-example', 'companies/widget-example']) {
      await engine.putPage(slug, { type: slug.startsWith('people/') ? 'person' : 'company', title: slug, compiled_truth: 'Fixture page.' });
    }
    const ids = await engine.executeRaw<{ slug: string; id: number }>(
      `SELECT slug, id FROM pages WHERE slug IN ('people/alice-example','companies/acme-example','companies/widget-example')`);
    const id = (slug: string) => ids.find(r => r.slug === slug)!.id;
    const [row] = await engine.executeRaw<{ id: unknown }>(
      `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status, ending_to_page_id, close_date)
       VALUES ('default', $1, $2, $3, 'works_at', 'e2e-6193', 'proposed', $2, '2024-05-01') RETURNING id`,
      [id('people/alice-example'), id('companies/acme-example'), id('companies/widget-example')]);
    expect(typeof row.id).toBe('bigint');
    proposalId = Number(row.id);
    home = mkdtempSync(join(tmpdir(), 'gbrain-edge-proposals-pg-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: process.env.DATABASE_URL }));
  }, 60_000);

  afterAll(async () => {
    await engine.executeRaw('DELETE FROM link_edge_proposals');
    await teardownDB();
    rmSync(home, { recursive: true, force: true });
  });

  test('list --json prints parseable rows with a numeric id', async () => {
    const r = await runCli(['edge-proposals', 'list', '--json'], { home, cwd: home, timeoutMs: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: proposalId, status: 'proposed', subject: 'people/alice-example', ending: 'companies/acme-example' });
  }, 90_000);

  test('show <id> --json prints one parseable document with a numeric id', async () => {
    const r = await runCli(['edge-proposals', 'show', String(proposalId), '--json'], { home, cwd: home, timeoutMs: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ id: proposalId, close_date: '2024-05-01' });
  }, 90_000);
});

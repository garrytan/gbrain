import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { attendanceRepairConnectionIdentity, parseAttendanceRepairArgs } from '../src/commands/extract-attendance-repair.ts';
import { runExtract } from '../src/commands/extract.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { attendanceRepairHash, type AttendanceRepairPreview } from '../src/core/attendance-repair.ts';

const flags = ['links', '--source', 'db', '--repair-attendance', '--source-id', 'repair-fixture'];
const env = { GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host', GBRAIN_SCHEMA_PACK: undefined,
  GBRAIN_NO_BANNER: '1', GBRAIN_MODEL_DISCOVERY: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1',
  ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };

describe('attendance repair CLI authority and private receipts', () => {
  let home: string;
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-repair-cli-')); mkdirSync(join(home, '.bun')); });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('embedded command rejects missing or remote local authority before engine use', async () => {
    for (const authority of [undefined, { remote: true }]) {
      await expect(runExtract({} as PGLiteEngine, flags, authority)).rejects.toThrow('trusted local');
    }
    expect(() => parseAttendanceRepairArgs(flags, { remote: undefined as unknown as boolean })).toThrow('trusted local');
  });

  test('repair help is engine-free and discoverable', async () => {
    for (const args of [['extract', '--help'], ['extract', '--repair-attendance', '--help'], ['--help']]) {
      const result = await runCli(args, { home, cwd: home, env });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--repair-attendance'); expect(result.stdout).toContain('--backup-verified');
      expect(result.stdout).toContain('--after-slug');
    }
    expect(existsSync(join(home, '.gbrain'))).toBe(false);
  });

  test('preview accepts a bounded source-page slug cursor', () => {
    expect(parseAttendanceRepairArgs([...flags, '--after-slug', 'topics/é-example', '--limit', '1'], { remote: false }))
      .toMatchObject({ afterSlug: 'topics/é-example', limit: 1 });
  });

  test.each([
    ['links', '--repair-attendance'],
    ['links', '--repair-attendance=true'], ['links', '--repair-attendance=false'],
    ['links', '--source', 'fs', '--repair-attendance', '--source-id', 'repair-fixture'],
    ['timeline', ...flags.slice(1)],
    ['all', ...flags.slice(1)],
    [...flags, '--stale'], [...flags, '--global'], [...flags, '--catch-up'], [...flags, '--dir', '.'],
    [...flags, '--include-frontmatter'], [...flags, '--by-mention'], [...flags, '--ner'],
    [...flags, '--limit', '1001'], [...flags, '--limit', '0'], [...flags, '--limit', '1.5'],
    [...flags, '--after-id', '1'], [...flags, '--after-slug', '\n'],
    [...flags, '--limit', '2', '--limit', '3'], [...flags, '--source-id', 'other'],
    [...flags, '--yes'], [...flags, '--apply-preview', 'missing'],
    [...flags, '--apply-preview', 'missing', '--confirm', '0'.repeat(64), '--yes', '--checkpoint', 'missing'],
    [...flags, '--apply-preview', 'missing', '--confirm', '0'.repeat(64), '--yes', '--backup-verified',
      '--checkpoint', 'missing', '--after-slug', 'meetings/example'],
  ].map(args => [args]))('invalid command refuses before creating a brain: %j', async args => {
    const before = readdirSync(home);
    const result = await runCli(['extract', ...args], { home, cwd: home, env, timeoutMs: 20_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('Setting up brain schema');
    expect(readdirSync(home)).toEqual(before);
  }, 30_000);

  test('thin-client command refuses without a remote request or local datastore', async () => {
    const thinHome = join(home, 'thin'); const brain = join(thinHome, '.gbrain'); mkdirSync(brain, { recursive: true });
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('unexpected', { status: 500 }); } });
    writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(brain, 'absent-db'),
      remote_mcp: { mcp_url: `http://127.0.0.1:${server.port}/mcp`, oauth_client_id: 'fixture', oauth_client_secret: 'fixture' } }));
    try {
      const result = await runCli(['extract', ...flags], { home: thinHome, cwd: thinHome, env, timeoutMs: 20_000 });
      expect(result.exitCode).toBe(1); expect(result.stderr).toContain('thin clients');
      expect(requests).toBe(0); expect(existsSync(join(brain, 'absent-db'))).toBe(false);
    } finally { await server.stop(true); }
  }, 30_000);

  test('real CLI preview is logical-read-only and exact private apply resumes idempotently', async () => {
    const local = join(home, 'local'); const brain = join(local, '.gbrain'); const privateDir = join(local, 'private');
    mkdirSync(brain, { recursive: true }); mkdirSync(privateDir, { mode: 0o700 });
    const databasePath = join(brain, 'brain.pglite');
    writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath }));
    const packDir = join(brain, 'schema-packs', 'repair-fixture'); mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'pack.json'), JSON.stringify({ api_version: 'gbrain-schema-pack-v1', name: 'repair-fixture',
      version: '1.0.0', extends: null, page_types: [], link_types: [], frontmatter_links: [] }));
    const engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite', database_path: databasePath }); await engine.initSchema();
    await engine.setConfig('schema_pack', 'repair-fixture');
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('repair-fixture','repair-fixture')");
    await engine.putPage('people/alice-example', { type: 'person', title: 'Example', compiled_truth: 'Person' }, { sourceId: 'repair-fixture' });
    await engine.putPage('meetings/planning', { type: 'meeting', title: 'Planning', compiled_truth: 'Attendees: [Example](../people/alice-example.md)' }, { sourceId: 'repair-fixture' });
    await engine.addLink('meetings/planning', 'people/alice-example', 'old evidence', 'attended', 'markdown', undefined, undefined,
      { fromSourceId: 'repair-fixture', toSourceId: 'repair-fixture' });
    const snapshot = async () => {
      const tables: Record<string, unknown> = {};
      for (const table of ['pages', 'links', 'config', 'op_checkpoints', 'page_write_guards']) {
        tables[table] = await engine.executeRaw(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`);
      }
      return tables;
    };
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const before = await snapshot(); await engine.disconnect();
    const invoke = (args: string[]) => runCli(['extract', ...args], { home: local, cwd: local, env, timeoutMs: 30_000 });
    const result = await invoke([...flags, '--json']);
    expect({ code: result.exitCode, stderr: result.stderr }).toMatchObject({ code: 0 });
    const preview = JSON.parse(result.stdout) as AttendanceRepairPreview;
    expect(preview.brain).toBe(attendanceRepairHash([attendanceRepairHash(incarnation),
      attendanceRepairConnectionIdentity('host', { engine: 'pglite', database_path: databasePath })]));
    expect(preview.counts).toMatchObject({ add: 1, remove: 1 });
    expect(readdirSync(privateDir)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain('Setting up brain schema');
    const next = await invoke([...flags, '--after-slug', preview.nextAfterSlug, '--limit', '1', '--json']);
    expect(next.exitCode).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ afterSlug: preview.nextAfterSlug, complete: true,
      counts: { scanned: 0, eligibleOrigins: 0 } });
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    expect(await snapshot()).toEqual(before); await engine.disconnect();
    const receipt = join(privateDir, 'preview.json'); const checkpoint = join(privateDir, 'cursor.json');
    writeFileSync(receipt, result.stdout, { mode: 0o600 });
    const apply = [...flags, '--apply-preview', receipt, '--confirm', preview.digest, '--yes', '--backup-verified', '--checkpoint', checkpoint];
    chmodSync(receipt, 0o644);
    expect((await invoke(apply)).exitCode).toBe(1); expect(existsSync(checkpoint)).toBe(false);
    chmodSync(receipt, 0o600);
    symlinkSync(receipt, checkpoint);
    expect((await invoke(apply)).exitCode).toBe(1); expect(readFileSync(receipt, 'utf8')).toBe(result.stdout);
    rmSync(checkpoint);
    const applied = await invoke(apply);
    expect({ code: applied.exitCode, stderr: applied.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(applied.stdout)).toMatchObject({ created: 1, removed: 1, committed: 1 });
    expect(statSync(checkpoint).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toMatchObject({ digest: preview.digest,
      afterSlug: preview.nextAfterSlug, pagesProcessed: preview.window.length });
    const resumed = await invoke(apply);
    expect({ code: resumed.exitCode, stderr: resumed.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(resumed.stdout)).toMatchObject({ created: 0, removed: 0, replayed: 1 });
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='attendance-repair'");
    const after = await snapshot(); await engine.disconnect();
    const expired = await invoke(apply);
    expect(expired.exitCode).toBe(1); expect(expired.stderr).toContain('commit proof expired');
    const freshResult = await invoke([...flags, '--json']);
    expect(freshResult.exitCode).toBe(0);
    const fresh = JSON.parse(freshResult.stdout) as AttendanceRepairPreview;
    expect(fresh.digest).not.toBe(preview.digest); expect(fresh.approvalId).not.toBe(preview.approvalId);
    expect(fresh.counts).toMatchObject({ add: 0, remove: 0 });
    const freshReceipt = join(privateDir, 'fresh-preview.json');
    const freshCheckpoint = join(privateDir, 'fresh-cursor.json');
    writeFileSync(freshReceipt, freshResult.stdout, { mode: 0o600 });
    const freshApply = [...flags, '--apply-preview', freshReceipt, '--confirm', fresh.digest, '--yes', '--backup-verified'];
    const reused = await invoke([...freshApply, '--checkpoint', checkpoint]);
    expect(reused.exitCode).toBe(1); expect(reused.stderr).toContain('Checkpoint belongs to another preview');
    const approved = await invoke([...freshApply, '--checkpoint', freshCheckpoint]);
    expect({ code: approved.exitCode, stderr: approved.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(approved.stdout)).toMatchObject({ created: 0, removed: 0, replayed: 0 });
    const nextReceipt = join(privateDir, 'next-preview.json');
    const nextPreview = JSON.parse(next.stdout) as AttendanceRepairPreview;
    writeFileSync(nextReceipt, next.stdout, { mode: 0o600 });
    const nextApply = [...flags, '--apply-preview', nextReceipt, '--confirm', nextPreview.digest, '--yes', '--backup-verified'];
    expect((await invoke([...nextApply, '--checkpoint', freshCheckpoint])).exitCode).toBe(1);
    expect((await invoke([...nextApply, '--checkpoint', join(privateDir, 'next-cursor.json')])).exitCode).toBe(0);
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    const final = await snapshot(); await engine.disconnect();
    for (const table of ['pages', 'links', 'config', 'page_write_guards']) expect(final[table]).toEqual(after[table]);
  }, 120_000);
});

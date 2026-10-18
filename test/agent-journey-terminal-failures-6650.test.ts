/**
 * #6650 (L3): the agent journey over terminal write failures, through the real CLI.
 *
 * A keyless PGLite brain with a managed source carries a pile of terminal receipts (pre-fix knock-on cancels from an
 * older build, caller conflicts, a refusal a later write superseded) and one committed receipt still holding a
 * publication recovery record. An agent with no TTY and no keys gets from the doctor warning to a verified clear in
 * three commands, each the previous one's structured output run verbatim (the knock-on pile is a day old, so no 24 h
 * spike rides along):
 *
 *   doctor --only persistence_terminal_failures --json   warn: the recovery record is the active blocker; fix.next = run
 *   <fix.command>                                        the owner pass clears the record
 *   <fix.verify.argv>                                    ok: no blocker, the pile is history or ordinary refusals
 *
 * The drill-down (`sources writer failures --group-by category --json`) classifies the same pile with an exact filter
 * per group. Real CLI subprocesses and a PGLite datastore in a temp home.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { knockOnDetail } from '../src/core/persistence/sync-knock-on.ts';
import { gb, oneDocument } from './helpers/agent-journey.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'journey-notes';
const CHECK = 'persistence_terminal_failures';
let home: string;
let blocker: string;

/** The shell an agent runs a rendered command in: split on spaces (every argv here is space-free). */
const argvOf = (command: string) => { const parts = command.split(' '); expect(parts[0]).toBe('gbrain'); return parts.slice(1); };
const checkOf = (doc: Record<string, any>) => (doc.checks as Array<Record<string, any>>).find(c => c.name === CHECK)!;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-6650-journey-'));
  const init = await gb(home, ['init', '--pglite', '--no-embedding', '--json']);
  expect(init.exitCode).toBe(0);
  const root = join(home, SOURCE);
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  writeFileSync(join(root, 'held.md'), '---\ntitle: Held\n---\nA page whose publication left a recovery record.\n');
  git('add', '.'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await withEnv({ HOME: home, GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [SOURCE, root]);
      await claimWorktree(engine, SOURCE, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const binding = (await getWorktreeBinding(engine, SOURCE))!;
      // The on-disk brain's writer floor is protocol 2: the fixture rows are written in one transaction that declares it.
      await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
      const seed = async (o: { slug: string; state: string; code?: string; detail?: unknown; recovery?: unknown; build?: string; hoursAgo?: number }) => {
        const requestId = randomUUID();
        await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,
            terminal_reservation,state,error_code,error_message,error_detail,recovery,recovery_bytes,intent,completed_at,updated_at,admitter_version,worktree_id)
          VALUES('local_cli','journey',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,$5,$6,'x',$7::text::jsonb,$8::text::jsonb,0,
            '{"content":"x"}'::jsonb,now()-($9::double precision*interval '1 hour'),now()-($9::double precision*interval '1 hour'),$10,$11::uuid)`,
        [requestId, SOURCE, o.slug, randomUUID(), o.state, o.code ?? null, o.detail === undefined ? null : JSON.stringify(o.detail),
          o.recovery === undefined ? null : JSON.stringify(o.recovery), o.hoursAgo ?? 2, o.build ?? '0.60.216.0', binding.worktree_id]);
        return requestId;
      };
      for (let i = 0; i < 20; i++) await seed({ slug: `notes/knock-${i}`, state: 'cancelled', code: 'storage_error', detail: knockOnDetail('window_predecessor', randomUUID()), build: '0.60.200.0', hoursAgo: 30 });
      for (let i = 0; i < 6; i++) await seed({ slug: `notes/conflict-${i}`, state: 'conflict', code: 'revision_conflict' });
      await seed({ slug: 'notes/rewritten', state: 'failed', code: 'storage_error', detail: { origin: 'owner_exception' }, hoursAgo: 3 });
      await seed({ slug: 'notes/rewritten', state: 'committed', hoursAgo: 1 });
      blocker = await seed({ slug: 'held', state: 'committed', recovery: { version: 1, path: join(root, 'held.md'), root, before: null, beforeHash: null, afterHash: null,
        mode: null, ownerEpoch: String(binding.owner_epoch), attempt: randomUUID() } });
      });
    } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
}, 180_000);
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe('terminal write failures: doctor warning to verified clear', () => {
  test('the drill-down classifies the pile with a filter per group', async () => {
    const doc = oneDocument(await gb(home, ['sources', 'writer', 'failures', SOURCE, '--group-by', 'category', '--state', 'all', '--json']), 'writer failures');
    const groups = doc.groups as Array<Record<string, any>>;
    expect(groups.find(g => g.category === 'knock_on')).toMatchObject({ rows: 20 });
    expect(groups.find(g => g.category === 'caller_conflict')).toMatchObject({ rows: 6, needs_human: false });
    for (const g of groups) expect(g.drill_down.slice(0, 5)).toEqual(['gbrain', 'sources', 'writer', 'failures', SOURCE]);
  }, 120_000);

  test('three commands: warn → run the fix → its verify is ok', async () => {
    const warned = checkOf(oneDocument(await gb(home, ['doctor', '--only', CHECK, '--json']), 'doctor warn'));
    expect(warned.status).toBe('warn');
    expect(warned.message).toContain(blocker);
    expect(warned.details.active_blockers).toEqual([expect.objectContaining({ kind: 'recovery', request_id: blocker, slug: 'held', category: 'recovery_pending' })]);
    // History never warns: the pre-fix knock-ons and the superseded refusal are counted apart from the blocker.
    expect(warned.details.historical_rows).toBe(21);
    expect(warned.fix.next).toBe('run');
    expect(warned.fix.command).toBe(`gbrain sync --source ${SOURCE} --no-pull --json --brain host`);

    const fixed = await gb(home, argvOf(warned.fix.command), { timeoutMs: 120_000 });
    expect(fixed.exitCode).toBe(0);

    expect(warned.fix.verify.argv.slice(0, 4)).toEqual(['gbrain', 'doctor', '--only', CHECK]);
    const verified = checkOf(oneDocument(await gb(home, warned.fix.verify.argv.slice(1)), 'doctor verify'));
    expect(verified.status).toBe('ok');
    expect(verified.details.active_blockers).toEqual([]);
    expect(verified.details.unresolved.rows).toBe(6);
    expect(verified.details.historical_rows).toBe(21);
  }, 300_000);
});

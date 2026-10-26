/**
 * A git effect the effect pass claimed and set aside for its root, followed by a claim that loses its connection (a
 * pooler drop or failover), stayed `running` until its 2-minute claim lease lapsed: the pass threw and nothing gave the
 * claim back. The crash robot's `pooler_disconnect` fault hit this on CI as a ~2-minute stall. The pass now gives back
 * every effect it claimed and had not started, fenced on each claim's token, as soon as the database answers again.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const connectionLost = () => Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6543'), { code: 'CONNECTION_CLOSED' });

/** The first transactionDirect after a git effect's claim returns fails with a dropped connection. */
function dropAfterGitClaim(engine: BrainEngine): BrainEngine {
  let armed = false; let fired = false;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transactionDirect') {
        return async (fn: never, opts: never) => {
          if (armed && !fired) { fired = true; throw connectionLost(); }
          const out = await target.transactionDirect(fn, opts) as { kind?: string; state?: string } | null;
          if (out && !Array.isArray(out) && out.kind === 'git' && out.state === 'running') armed = true;
          return out;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function queueEffects(engine: BrainEngine, git: Record<string, unknown>): Promise<void> {
  const [{ incarnation, worktree }] = await engine.executeRaw<{ incarnation: string; worktree: string }>(
    "SELECT source_incarnation::text AS incarnation, worktree_id::text AS worktree FROM persistence_source_bindings WHERE source_id='default'");
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
    const [request] = await tx.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,completed_at) VALUES ('local_cli','test',$1::uuid,'put_page','default',$2::uuid,'notes/alpha-example','x','{}'::jsonb,0,16384,'committed',now()) RETURNING id::text`,
      [randomUUID(), incarnation]);
    await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,state,source_id,source_incarnation,worktree_id,next_attempt_at)
      VALUES ($1::uuid,'git',$2::text::jsonb,'queued','default',$3::uuid,$4::uuid,now()-interval '1 minute'),
             ($1::uuid,'links',$5::text::jsonb,'queued','default',$3::uuid,NULL,now())`,
      [request!.id, JSON.stringify(git), incarnation, worktree, JSON.stringify({ slug: 'notes/alpha-example' })]);
  });
}

for (const backend of testBackends()) describe(`[${backend}] an effect pass that loses its connection gives back the git effects it set aside`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const cases = [
    ['the next claim', { slug: 'notes/alpha-example', page_id: 1, expected_hash: null, relative_path: 'notes/alpha-example.md', version: 1 }],
    ['the claim of its coalesced siblings', { slug: 'notes/alpha-example', page_id: 1, expected_hash: null, relative_path: 'notes/alpha-example.md' }],
  ] as const;
  for (const [failing, git] of cases) {
    test(`forced probe: ${failing} fails on a dropped connection; the set-aside git effect is queued again, not running under its lease`, () => managedBrain(async ({ engine }) => {
      await queueEffects(engine, git);
      await expect(runPersistenceEffects(dropAfterGitClaim(engine), { engine: engine.kind }, { hostId: localHostId(), limit: 5 }))
        .rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      const [effect] = await engine.executeRaw<{ state: string; token: string | null; lease: string | null }>(
        "SELECT state, execution_token::text AS token, claim_expires_at::text AS lease FROM persistence_effects WHERE kind='git'");
      expect(effect).toEqual({ state: 'queued', token: null, lease: null });
    }, { databaseUrl }));
  }
});

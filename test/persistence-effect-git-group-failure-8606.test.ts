/**
 * #8606: a single-file Git effect whose grouped completion keeps failing used to retry forever once an earlier
 * attempt had failed on its target: the grouped completion recorded its failures without the target, so each one
 * reset the consecutive-failure count to 1 and the five-failure park never came. It now carries the target.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { EFFECT_FAULT_POINTS, installFaultHook } from '../src/core/persistence/fault-points.ts';
import { managedBrain } from './helpers/managed-brain.ts';

afterEach(() => installFaultHook(undefined));

type GitEffect = { id: number; state: string; error_code: string | null; data: Record<string, unknown> };
const gitEffect = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<GitEffect>(`SELECT e.id,e.state,e.error_code,e.data
  FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND r.slug=$1`, [slug]))[0]!;

/** One effect pass with every other effect deferred. */
async function attempt(engine: BrainEngine, ctx: OperationContext, id: number) {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=CASE WHEN id=$1 THEN now() ELSE now()+interval '1 hour' END", [id]);
  });
  await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 1 });
}

test('a Git effect whose grouped completion keeps failing parks even after an earlier failure on its target', async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    const slug = 'notes/alice-example';
    await submitPageMutation(ctx, { operation: 'put_page',
      params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: Alice Example\n---\n\nBody.\n` } });
    await disposePersistenceConsumer(engine);
    const effect = await gitEffect(engine, slug);
    expect(effect.state).toBe('queued');
    const file = join(root, `${slug}.md`);
    chmodSync(file, 0o000);
    try { await attempt(engine, ctx, effect.id); } finally { chmodSync(file, 0o644); }
    expect(await gitEffect(engine, slug)).toMatchObject({ state: 'queued', data: { target_failures: 1, failing_target: slug } });

    installFaultHook(point => { if (point === EFFECT_FAULT_POINTS.git) throw new Error('grouped Git completion failed'); });
    for (let i = 0; i < 3; i++) await attempt(engine, ctx, effect.id);
    expect(await gitEffect(engine, slug)).toMatchObject({ state: 'queued', data: { target_failures: 4, failing_target: slug } });
    await attempt(engine, ctx, effect.id);
    expect(await gitEffect(engine, slug)).toMatchObject({ state: 'failed', error_code: 'targets_parked', data: { parked: [{ slug }] } });
  });
}, 120_000);

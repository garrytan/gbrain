import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runAutopilot } from '../src/commands/autopilot.ts';
import { runDream } from '../src/commands/dream.ts';
import { createLifecycleForgettingStoreForEngine } from '../src/core/maintenance/lifecycle-forgetting.ts';
import { createLifecycleForgettingServiceForEngine } from '../src/core/services/lifecycle-forgetting-engine-service.ts';
import type { LifecycleForgettingService } from '../src/core/services/lifecycle-forgetting-service.ts';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

const NOW = '2026-05-21T09:00:00.000Z';
const LATER = '2026-05-22T09:00:00.000Z';

postgresTest('postgres lifecycle forgetting helper persists transitions and tombstones', async () => {
  await withPostgresLifecycleHarness(async ({ engine, service }) => {
    const transitionEntityId = `projection:${crypto.randomUUID()}`;
    const purgeEntityId = `source-chunk:${crypto.randomUUID()}`;
    const store = createLifecycleForgettingStoreForEngine(engine);

    const transition = await service.transitionEntity({
      entity_type: 'projection_target',
      entity_id: transitionEntityId,
      to_lifecycle_state: 'stale',
      reason: 'postgres projection needs reconcile',
      restore_until: LATER,
      now: NOW,
    });
    const purgePolicy = await store.upsertForgettingPolicy({
      id: `forgetting-policy:${crypto.randomUUID()}`,
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      purge_eligible: true,
      now: NOW,
    });
    await service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: purgeEntityId,
      to_lifecycle_state: 'expired',
      policy_id: purgePolicy.id,
      reason: 'postgres retention candidate',
      purge_after: '2026-05-21T08:00:00.000Z',
      now: NOW,
    });
    const approvedPlan = await createApprovedPurgePlan(store, 'source_chunk', purgeEntityId);
    const purge = await service.purgeEntity({
      entity_type: 'source_chunk',
      entity_id: purgeEntityId,
      reason: 'postgres retention elapsed',
      content_hash: 'sha256:postgres-before',
      metadata_json: { content_removed: true },
      purge_plan_id: approvedPlan.id,
      now: NOW,
    });

    const states = await engine.sql`
      SELECT lifecycle_state, reason, restore_until, last_transition_event_id
      FROM memory_lifecycle_states
      WHERE entity_type = ${'projection_target'}
        AND entity_id = ${transitionEntityId}
    `;
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      lifecycle_state: 'stale',
      reason: 'postgres projection needs reconcile',
      last_transition_event_id: transition.event.id,
    });
    expect(new Date(states[0]!.restore_until as Date).toISOString()).toBe(LATER);

    const tombstones = await engine.sql`
      SELECT entity_type, entity_id, purge_event_id, reason, content_hash, metadata_json
      FROM memory_tombstones
      WHERE entity_type = ${'source_chunk'}
        AND entity_id = ${purgeEntityId}
    `;
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      entity_type: 'source_chunk',
      entity_id: purgeEntityId,
      purge_event_id: purge.event.id,
      reason: 'postgres retention elapsed',
      content_hash: 'sha256:postgres-before',
    });
    const metadataJson = typeof tombstones[0]!.metadata_json === 'string'
      ? JSON.parse(tombstones[0]!.metadata_json)
      : tombstones[0]!.metadata_json;
    expect(metadataJson).toEqual({ content_removed: true });
  });
}, 20_000);

postgresTest('postgres lifecycle purge rolls back transition writes when duplicate tombstone fails', async () => {
  await withPostgresLifecycleHarness(async ({ engine, service }) => {
    const entityId = `assertion:${crypto.randomUUID()}`;
    const store = createLifecycleForgettingStoreForEngine(engine);
    const purgePolicy = await store.upsertForgettingPolicy({
      id: `forgetting-policy:${crypto.randomUUID()}`,
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await service.transitionEntity({
      entity_type: 'assertion',
      entity_id: entityId,
      to_lifecycle_state: 'expired',
      policy_id: purgePolicy.id,
      reason: 'initial postgres purge candidate',
      purge_after: '2026-05-21T08:00:00.000Z',
      now: NOW,
    });
    const approvedPlan = await createApprovedPurgePlan(store, 'assertion', entityId);

    await service.purgeEntity({
      entity_type: 'assertion',
      entity_id: entityId,
      reason: 'initial postgres purge',
      content_hash: 'sha256:postgres-first',
      purge_plan_id: approvedPlan.id,
      now: NOW,
    });

    await expect(service.purgeEntity({
      entity_type: 'assertion',
      entity_id: entityId,
      reason: 'second postgres purge should roll back',
      content_hash: 'sha256:postgres-second',
      now: '2026-05-21T09:05:00.000Z',
    })).rejects.toThrow();

    const states = await engine.sql`
      SELECT lifecycle_state, reason
      FROM memory_lifecycle_states
      WHERE entity_type = ${'assertion'}
        AND entity_id = ${entityId}
    `;
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      lifecycle_state: 'purged',
      reason: 'initial postgres purge',
    });

    const events = await engine.sql`
      SELECT event_type, reason
      FROM forgetting_events
      WHERE entity_type = ${'assertion'}
        AND entity_id = ${entityId}
      ORDER BY created_at ASC, id ASC
    `;
    const eventSummaries = events.map((row) => ({
      event_type: row.event_type,
      reason: row.reason,
    }));
    expect(eventSummaries).toHaveLength(2);
    expect(eventSummaries).toContainEqual({
      event_type: 'purged',
      reason: 'initial postgres purge',
    });
    expect(eventSummaries.some((event) => event.reason === 'second postgres purge should roll back')).toBe(false);

    const tombstones = await engine.sql`
      SELECT reason, content_hash
      FROM memory_tombstones
      WHERE entity_type = ${'assertion'}
        AND entity_id = ${entityId}
    `;
    expect(tombstones.map((row) => ({
      reason: row.reason,
      content_hash: row.content_hash,
    }))).toEqual([{
      reason: 'initial postgres purge',
      content_hash: 'sha256:postgres-first',
    }]);
  });
}, 20_000);

postgresTest('postgres dream CLI wires lifecycle forgetting into the real phase runner', async () => {
  await withPostgresLifecycleHarness(async ({ engine, service }) => {
    await seedPostgresPurgeCandidate(engine, service);

    const { stdout } = await captureConsole(() => runDream(engine, [
      '--scope-id', 'workspace:default',
      '--now', NOW,
      '--dry-run',
    ]));
    const result = JSON.parse(stdout);
    const forgetting = result.phases.find((phase: any) => phase.family === 'forgetting_review');

    expect(forgetting).toMatchObject({
      status: 'warn',
      skip_reason: null,
      counts: { purge_candidates: 1 },
    });
  });
}, 20_000);

postgresTest('postgres autopilot dream wires lifecycle forgetting into the real phase runner', async () => {
  await withPostgresLifecycleHarness(async ({ engine, service }) => {
    await seedPostgresPurgeCandidate(engine, service);

    const { stdout } = await captureConsole(() => runAutopilot([
      'dream',
      '--scope-id', 'workspace:default',
      '--now', NOW,
      '--dry-run',
    ], { engine }));
    const result = JSON.parse(stdout);
    const forgetting = result.phases.find((phase: any) => phase.family === 'forgetting_review');

    expect(forgetting).toMatchObject({
      status: 'warn',
      skip_reason: null,
      counts: { purge_candidates: 1 },
    });
  });
}, 20_000);

postgresTest('postgres source-kind policies gate purge planning without explicit lifecycle policy ids', async () => {
  await withPostgresLifecycleHarness(async ({ engine, service }) => {
    const store = createLifecycleForgettingStoreForEngine(engine);
    await engine.sql`
      INSERT INTO sources (
        id, kind, display_name, consent_state, enabled, metadata_json, created_at, updated_at
      ) VALUES
        (${'source:user-direct'}, ${'user_direct'}, ${'User direct'}, ${'granted'}, ${true}, ${'{}'}::jsonb, ${NOW}, ${NOW}),
        (${'source:session'}, ${'codex_session'}, ${'Codex session'}, ${'granted'}, ${true}, ${'{}'}::jsonb, ${NOW}, ${NOW})
    `;
    await engine.sql`
      INSERT INTO source_items (
        id, source_id, external_id, origin_event, title, ingested_at, content_hash,
        metadata_json, raw_copy_mode, sensitivity_level, ingest_status
      ) VALUES
        (${'source-item:user-direct'}, ${'source:user-direct'}, ${'user-direct'}, ${'session_capture'}, ${'User direct'}, ${NOW}, ${'sha256:user-direct'}, ${'{}'}::jsonb, ${'none'}, ${'normal'}, ${'ready'}),
        (${'source-item:session'}, ${'source:session'}, ${'session'}, ${'session_capture'}, ${'Session'}, ${NOW}, ${'sha256:session'}, ${'{}'}::jsonb, ${'none'}, ${'normal'}, ${'ready'})
    `;
    await engine.sql`
      INSERT INTO source_chunks (
        id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text,
        token_count, parser_version, extractor_version, sensitivity_flags,
        prompt_injection_risk, secret_risk, created_at
      ) VALUES
        (${'source-chunk:user-direct'}, ${'source-item:user-direct'}, ${0}, ${'sha256:chunk-user-direct'}, ${'user direct text'}, ${''}, ${3}, ${'test-parser'}, ${'test-extractor'}, ${'[]'}::jsonb, ${'none'}, ${'none'}, ${NOW}),
        (${'source-chunk:session'}, ${'source-item:session'}, ${0}, ${'sha256:chunk-session'}, ${'session text'}, ${''}, ${3}, ${'test-parser'}, ${'test-extractor'}, ${'[]'}::jsonb, ${'none'}, ${'none'}, ${NOW})
    `;
    await store.upsertForgettingPolicy({
      id: 'forgetting-policy:postgres-user-direct-purge',
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      source_kind: 'user_direct',
      purge_eligible: true,
      now: NOW,
    });
    await store.upsertForgettingPolicy({
      id: 'forgetting-policy:postgres-session-retain',
      scope_id: 'workspace:default',
      entity_type: 'source_chunk',
      source_kind: 'codex_session',
      purge_eligible: false,
      now: NOW,
    });
    await service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:user-direct',
      to_lifecycle_state: 'expired',
      reason: 'user direct retention elapsed',
      purge_after: '2026-05-21T08:00:00.000Z',
      now: NOW,
    });
    await service.transitionEntity({
      entity_type: 'source_chunk',
      entity_id: 'source-chunk:session',
      to_lifecycle_state: 'expired',
      reason: 'session retention elapsed',
      purge_after: '2026-05-21T08:00:00.000Z',
      now: NOW,
    });

    const purgePlan = await service.planPurgeCandidates({
      scope_id: 'workspace:default',
      reason: 'postgres source-kind policy review',
      now: NOW,
    });

    expect(purgePlan.items.map((item) => item.entity_id)).toEqual(['source-chunk:user-direct']);
  });
}, 20_000);

postgresTest('postgres source item purge creates child source chunk lifecycle audit and tombstones', async () => {
  await withPostgresLifecycleHarness(async ({ engine, service }) => {
    const store = createLifecycleForgettingStoreForEngine(engine);
    const sourceId = `source:${crypto.randomUUID()}`;
    const sourceItemId = `source-item:${crypto.randomUUID()}`;
    const sourceChunkA = `source-chunk:${crypto.randomUUID()}:0`;
    const sourceChunkB = `source-chunk:${crypto.randomUUID()}:1`;
    await engine.sql`
      INSERT INTO sources (
        id, kind, display_name, consent_state, enabled, metadata_json, created_at, updated_at
      ) VALUES (
        ${sourceId}, ${'codex_session'}, ${'Postgres source item purge'}, ${'granted'}, ${true}, ${'{}'}::jsonb, ${NOW}, ${NOW}
      )
    `;
    await engine.sql`
      INSERT INTO source_items (
        id, source_id, external_id, origin_event, title, ingested_at, content_hash,
        metadata_json, raw_copy_mode, sensitivity_level, ingest_status
      ) VALUES (
        ${sourceItemId}, ${sourceId}, ${sourceItemId}, ${'session_capture'}, ${'Postgres purge item'}, ${NOW},
        ${'sha256:postgres-source-item'}, ${'{}'}::jsonb, ${'none'}, ${'normal'}, ${'ready'}
      )
    `;
    await engine.sql`
      INSERT INTO source_chunks (
        id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text,
        token_count, parser_version, extractor_version, sensitivity_flags,
        prompt_injection_risk, secret_risk, created_at
      ) VALUES
        (${sourceChunkA}, ${sourceItemId}, ${0}, ${'sha256:postgres-child-a'}, ${'postgres child raw text a'}, ${''}, ${4}, ${'test-parser'}, ${'test-extractor'}, ${'[]'}::jsonb, ${'none'}, ${'none'}, ${NOW}),
        (${sourceChunkB}, ${sourceItemId}, ${1}, ${'sha256:postgres-child-b'}, ${'postgres child raw text b'}, ${''}, ${4}, ${'test-parser'}, ${'test-extractor'}, ${'[]'}::jsonb, ${'none'}, ${'none'}, ${NOW})
    `;
    const policy = await store.upsertForgettingPolicy({
      id: `forgetting-policy:${crypto.randomUUID()}`,
      scope_id: 'workspace:default',
      entity_type: 'source_item',
      purge_eligible: true,
      now: NOW,
    });
    await service.transitionEntity({
      entity_type: 'source_item',
      entity_id: sourceItemId,
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'postgres source item retention elapsed',
      purge_after: '2026-05-21T08:00:00.000Z',
      now: NOW,
    });
    const approvedPlan = await createApprovedPurgePlan(store, 'source_item', sourceItemId);

    await service.purgeEntity({
      entity_type: 'source_item',
      entity_id: sourceItemId,
      reason: 'postgres source item purge',
      content_hash: 'sha256:postgres-source-item',
      purge_plan_id: approvedPlan.id,
      now: NOW,
    });

    const chunks = await engine.sql`
      SELECT id, chunk_text, token_count, expires_at
      FROM source_chunks
      WHERE source_item_id = ${sourceItemId}
      ORDER BY chunk_index ASC
    `;
    expect(chunks.map((row) => ({
      id: row.id,
      chunk_text: row.chunk_text,
      token_count: Number(row.token_count),
      expires_at: new Date(row.expires_at as Date).toISOString(),
    }))).toEqual([
      { id: sourceChunkA, chunk_text: '', token_count: 0, expires_at: NOW },
      { id: sourceChunkB, chunk_text: '', token_count: 0, expires_at: NOW },
    ]);

    const childStates = await engine.sql`
      SELECT entity_id, lifecycle_state, reason
      FROM memory_lifecycle_states
      WHERE entity_type = ${'source_chunk'}
        AND entity_id IN (${sourceChunkA}, ${sourceChunkB})
      ORDER BY entity_id ASC
    `;
    expect(childStates.map((row) => ({
      entity_id: row.entity_id,
      lifecycle_state: row.lifecycle_state,
      reason: row.reason,
    }))).toEqual([
      { entity_id: sourceChunkA, lifecycle_state: 'purged', reason: 'postgres source item purge' },
      { entity_id: sourceChunkB, lifecycle_state: 'purged', reason: 'postgres source item purge' },
    ].sort((a, b) => a.entity_id.localeCompare(b.entity_id)));

    const childTombstones = await engine.sql`
      SELECT entity_id, purge_plan_id, reason, content_hash, metadata_json
      FROM memory_tombstones
      WHERE entity_type = ${'source_chunk'}
        AND entity_id IN (${sourceChunkA}, ${sourceChunkB})
      ORDER BY entity_id ASC
    `;
    expect(childTombstones).toHaveLength(2);
    expect(childTombstones.map((row) => ({
      entity_id: row.entity_id,
      purge_plan_id: row.purge_plan_id,
      reason: row.reason,
      content_hash: row.content_hash,
    }))).toEqual([
      {
        entity_id: sourceChunkA,
        purge_plan_id: approvedPlan.id,
        reason: 'postgres source item purge',
        content_hash: 'sha256:postgres-child-a',
      },
      {
        entity_id: sourceChunkB,
        purge_plan_id: approvedPlan.id,
        reason: 'postgres source item purge',
        content_hash: 'sha256:postgres-child-b',
      },
    ].sort((a, b) => a.entity_id.localeCompare(b.entity_id)));
  });
}, 20_000);

async function withPostgresLifecycleHarness(
  fn: (harness: { engine: PostgresEngine; service: LifecycleForgettingService }) => Promise<void>,
): Promise<void> {
  if (!databaseUrl) return;

  const engine = new PostgresEngine();
  const schemaName = `lifecycle_forgetting_${crypto.randomUUID().replaceAll('-', '_')}`;

  await engine.connect({ engine: 'postgres', database_url: databaseUrl, poolSize: 1 });
  await engine.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await engine.sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await engine.sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await engine.sql.unsafe(`SET search_path TO "${schemaName}", public`);

  try {
    await engine.initSchema();
    const service = await createLifecycleForgettingServiceForEngine(engine);
    await fn({ engine, service });
  } finally {
    await engine.sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await engine.disconnect();
  }
}

async function createApprovedPurgePlan(
  store: ReturnType<typeof createLifecycleForgettingStoreForEngine>,
  entityType: string,
  entityId: string,
) {
  const plan = await store.createPurgePlan({
    id: `purge-plan:postgres:${entityType}:${entityId}:${crypto.randomUUID()}`,
    scope_id: 'workspace:default',
    status: 'approved',
    reason: 'approved postgres purge review',
    requested_by: 'test',
    created_at: NOW,
  });
  await store.createPurgePlanItem({
    plan_id: plan.id,
    entity_type: entityType,
    entity_id: entityId,
    lifecycle_state: 'expired',
    status: 'approved',
    purge_after: '2026-05-21T08:00:00.000Z',
    created_at: NOW,
  });
  return plan;
}

async function seedPostgresPurgeCandidate(
  engine: PostgresEngine,
  service: LifecycleForgettingService,
): Promise<void> {
  const store = createLifecycleForgettingStoreForEngine(engine);
  const policy = await store.upsertForgettingPolicy({
    id: `forgetting-policy:${crypto.randomUUID()}`,
    scope_id: 'workspace:default',
    entity_type: 'assertion',
    purge_eligible: true,
    now: NOW,
  });
  await service.transitionEntity({
    entity_type: 'assertion',
    entity_id: `assertion:${crypto.randomUUID()}`,
    to_lifecycle_state: 'expired',
    policy_id: policy.id,
    reason: 'expired before dream review',
    purge_after: '2026-05-21T08:00:00.000Z',
    now: NOW,
  });
}

async function captureConsole(run: () => Promise<void> | void): Promise<{ stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  try {
    await run();
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

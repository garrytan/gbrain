import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  canonicalJson,
  hashCanonicalJson,
  resolveTargetSnapshotHash,
} from '../src/core/services/target-snapshot-hash-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { MemoryMutationTargetKind } from '../src/core/types.ts';
import { contentHash } from '../src/core/utils.ts';

interface EngineHarness {
  label: 'sqlite' | 'pglite';
  engine: BrainEngine;
  cleanup: () => Promise<void>;
}

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-target-snapshot-sqlite-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();
  return {
    label: 'sqlite',
    engine,
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-target-snapshot-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();
  return {
    label: 'pglite',
    engine,
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedRepresentativeTargets(engine: BrainEngine): Promise<void> {
  await engine.createTaskThread({
    id: 'task:snapshot',
    scope: 'work',
    title: 'Snapshot Task',
    goal: 'Exercise all non-page target hash payloads.',
    status: 'active',
    repo_path: '/repo/mbrain',
    branch_name: 'phase9-memory-operations-control-plane',
    current_summary: 'Target snapshot hash parity should cover operational memory records.',
  });
  await engine.upsertTaskWorkingSet({
    task_id: 'task:snapshot',
    active_paths: ['src/core/services/target-snapshot-hash-service.ts'],
    active_symbols: ['resolveTargetSnapshotHash'],
    blockers: [],
    open_questions: ['Does parity cover JSON payload records?'],
    next_steps: ['Keep target hashes deterministic across engines.'],
    verification_notes: ['Parity test seeded the working set.'],
    last_verified_at: new Date('2026-04-24T08:09:10.000Z'),
  });
  await engine.upsertMemoryRealm({
    id: 'realm:snapshot',
    name: 'Snapshot Realm',
    description: 'Realm used by target snapshot hash tests.',
    scope: 'work',
    default_access: 'read_write',
    retention_policy: 'retain-for-review',
    export_policy: 'restricted',
    agent_instructions: 'Keep target hashes stable across engines.',
    archived_at: new Date('2026-04-25T01:02:03.000Z'),
  });
  await engine.createMemorySession({
    id: 'session-snapshot',
    task_id: 'task-snapshot',
    actor_ref: 'agent:target-snapshot-test',
    expires_at: new Date('2999-01-01T00:00:00.000Z'),
  });
  await engine.attachMemoryRealmToSession({
    session_id: 'session-snapshot',
    realm_id: 'realm:snapshot',
    access: 'read_only',
    instructions: 'Use for target snapshot tests.',
  });
  await engine.upsertProfileMemoryEntry({
    id: 'profile:snapshot',
    scope_id: 'personal:default',
    profile_type: 'preference',
    subject: 'hashing',
    content: 'Prefer deterministic target snapshot hashes.',
    source_refs: ['Source: target snapshot hash service test'],
    sensitivity: 'personal',
    export_status: 'private_only',
    last_confirmed_at: new Date('2026-04-24T03:04:05.000Z'),
    superseded_by: null,
  });
  await engine.createPersonalEpisodeEntry({
    id: 'episode:snapshot',
    scope_id: 'personal:default',
    title: 'Snapshot planning',
    start_time: new Date('2026-04-23T11:00:00.000Z'),
    end_time: new Date('2026-04-23T11:30:00.000Z'),
    source_kind: 'chat',
    summary: 'Planned hash generation for heterogeneous memory records.',
    source_refs: ['Source: target snapshot hash service test'],
    candidate_ids: ['candidate:snapshot'],
  });
  await engine.createMemoryCandidateEntry({
    id: 'candidate:snapshot',
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: 'Target snapshot hashes should be deterministic.',
    source_refs: ['Source: target snapshot hash service test'],
    generated_by: 'agent',
    extraction_kind: 'extracted',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/target-snapshot-hash',
    reviewed_at: new Date('2026-04-24T05:06:07.000Z'),
    review_reason: 'Representative target for hash parity.',
  });
  await engine.upsertContextMapEntry({
    id: 'context-map:snapshot',
    scope_id: 'workspace:default',
    kind: 'structural',
    title: 'Snapshot Context Map',
    build_mode: 'test',
    status: 'ready',
    source_set_hash: 'source-set:snapshot',
    extractor_version: 'target-snapshot-test',
    node_count: 1,
    edge_count: 0,
    community_count: 1,
    graph_json: {
      nodes: [{
        id: 'node:snapshot',
        label: 'Snapshot Node',
        created_at: '2026-04-24T08:09:10.000Z',
      }],
      edges: [],
      metadata: {
        created_at: '2026-04-24T08:09:11.000Z',
      },
    },
    stale_reason: null,
  });
  await engine.upsertContextAtlasEntry({
    id: 'context-atlas:snapshot',
    map_id: 'context-map:snapshot',
    scope_id: 'workspace:default',
    kind: 'structural',
    title: 'Snapshot Context Atlas',
    freshness: 'fresh',
    entrypoints: ['node:snapshot'],
    budget_hint: 512,
  });
}

describe('target snapshot hash service canonical JSON', () => {
  test('object key order does not change the canonical hash', () => {
    const left = hashCanonicalJson({
      b: 2,
      a: {
        d: new Date('2026-04-25T01:02:03.000Z'),
        c: null,
      },
    });
    const right = hashCanonicalJson({
      a: {
        c: null,
        d: '2026-04-25T01:02:03.000Z',
      },
      b: 2,
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  test('array order changes the canonical hash', () => {
    expect(hashCanonicalJson({ refs: ['a', 'b'] })).not.toBe(
      hashCanonicalJson({ refs: ['b', 'a'] }),
    );
  });

  test('Date values and ISO strings normalize consistently', () => {
    expect(canonicalJson({ at: new Date('2026-04-25T01:02:03.000Z') })).toBe(
      canonicalJson({ at: '2026-04-25T01:02:03Z' }),
    );
  });

  test('top-level volatile storage keys are omitted without dropping semantic nested fields', () => {
    expect(hashCanonicalJson({
      id: 'context-map:snapshot',
      created_at: '2026-04-25T01:02:03.000Z',
      graph_json: { nodes: [{ id: 'node:snapshot' }] },
    })).toBe(hashCanonicalJson({
      id: 'context-map:snapshot',
      created_at: '2026-04-26T01:02:03.000Z',
      graph_json: { nodes: [{ id: 'node:snapshot' }] },
    }));

    expect(hashCanonicalJson({
      graph_json: { nodes: [{ id: 'node:snapshot', created_at: '2026-04-25T01:02:03.000Z' }] },
    })).not.toBe(hashCanonicalJson({
      graph_json: { nodes: [{ id: 'node:snapshot', created_at: '2026-04-26T01:02:03.000Z' }] },
    }));
  });

  test('unsupported object values and bigint values are rejected', () => {
    expect(() => hashCanonicalJson({ value: new Map([['key', 'value']]) })).toThrow(/unsupported object/i);
    expect(() => hashCanonicalJson({ value: /unsupported/ })).toThrow(/unsupported object/i);
    expect(() => hashCanonicalJson({ value: 1n })).toThrow(/unsupported JSON value type: bigint/i);
    expect(() => hashCanonicalJson({ value: undefined })).toThrow(/unsupported JSON value type: undefined/i);
  });
});

describe('target snapshot hash resolution', () => {
  test('page targets use the stored content_hash when it is available', async () => {
    const harness = await createSqliteHarness();
    try {
      const storedHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      await harness.engine.putPage('concepts/snapshot-page', {
        type: 'concept',
        title: 'Snapshot Page',
        compiled_truth: 'The stored page hash is authoritative for page targets.',
        timeline: '- 2026-04-25: Added snapshot page.',
        content_hash: storedHash,
      });

      const result = await resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'page',
        target_id: 'concepts/snapshot-page',
      });

      expect(result).toEqual({
        target_kind: 'page',
        target_id: 'concepts/snapshot-page',
        target_snapshot_hash: storedHash,
        hash_source: 'page.content_hash',
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('page targets compute the page contentHash fallback when content_hash is absent', async () => {
    const page = {
      slug: 'concepts/no-stored-hash',
      type: 'concept' as const,
      title: 'No Stored Hash',
      compiled_truth: 'Fallback hash uses the page content contract.',
      timeline: '- 2026-04-25: Fallback path.',
      frontmatter: {},
      created_at: new Date('2026-04-25T01:02:03.000Z'),
      updated_at: new Date('2026-04-25T01:02:03.000Z'),
    };
    const engine = {
      getPage: async () => page,
    } as unknown as BrainEngine;

    const result = await resolveTargetSnapshotHash(engine, {
      target_kind: 'page',
      target_id: page.slug,
    });

    expect(result?.target_snapshot_hash).toBe(contentHash(page.compiled_truth, page.timeline));
    expect(result?.hash_source).toBe('page.content_hash_fallback');
  });

  test('missing targets return null', async () => {
    const harness = await createSqliteHarness();
    try {
      await expect(resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'page',
        target_id: 'concepts/missing',
      })).resolves.toBeNull();
      await expect(resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'memory_realm',
        target_id: 'realm:missing',
      })).resolves.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test('unsupported target kinds throw clearly instead of hashing the wrong thing', async () => {
    const harness = await createSqliteHarness();
    try {
      await expect(resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'source_record',
        target_id: 'source:unsupported',
      })).rejects.toThrow(/unsupported target_kind: source_record/i);
    } finally {
      await harness.cleanup();
    }
  });

  test('memory session attachment target ids resolve when both ids contain colons', async () => {
    const harness = await createSqliteHarness();
    try {
      await harness.engine.upsertMemoryRealm({
        id: 'realm:colon:snapshot',
        name: 'Colon Snapshot Realm',
        scope: 'work',
      });
      await harness.engine.createMemorySession({
        id: 'session:colon:snapshot',
      });
      await harness.engine.attachMemoryRealmToSession({
        session_id: 'session:colon:snapshot',
        realm_id: 'realm:colon:snapshot',
        access: 'read_only',
        instructions: 'Attachment target id parser must handle colons.',
      });

      const result = await resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'memory_session_attachment',
        target_id: 'session:colon:snapshot:realm:colon:snapshot',
      });

      expect(result).toMatchObject({
        target_kind: 'memory_session_attachment',
        target_id: 'session:colon:snapshot:realm:colon:snapshot',
        hash_source: 'canonical_json',
      });
      expect(result?.target_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await harness.cleanup();
    }
  });

  test('memory session attachment target ids support injective encoded form', async () => {
    const harness = await createSqliteHarness();
    try {
      await harness.engine.upsertMemoryRealm({
        id: 'b:c:d',
        name: 'Legacy Ambiguous Realm',
        scope: 'work',
      });
      await harness.engine.upsertMemoryRealm({
        id: 'c:d',
        name: 'Encoded Realm',
        scope: 'work',
      });
      await harness.engine.createMemorySession({ id: 'a' });
      await harness.engine.createMemorySession({ id: 'a:b' });
      await harness.engine.attachMemoryRealmToSession({
        session_id: 'a',
        realm_id: 'b:c:d',
        access: 'read_only',
        instructions: 'Legacy ambiguous attachment.',
      });
      await harness.engine.attachMemoryRealmToSession({
        session_id: 'a:b',
        realm_id: 'c:d',
        access: 'read_write',
        instructions: 'Encoded target id should select this attachment.',
      });

      const result = await resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'memory_session_attachment',
        target_id: 'memory_session_attachment:v1:a%3Ab:c%3Ad',
      });

      expect(result).toEqual({
        target_kind: 'memory_session_attachment',
        target_id: 'memory_session_attachment:v1:a%3Ab:c%3Ad',
        target_snapshot_hash: hashCanonicalJson({
          session_id: 'a:b',
          realm_id: 'c:d',
          access: 'read_write',
          instructions: 'Encoded target id should select this attachment.',
        }),
        hash_source: 'canonical_json',
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('prefix-shaped legacy memory session attachment target ids still resolve', async () => {
    const harness = await createSqliteHarness();
    try {
      await harness.engine.upsertMemoryRealm({
        id: 'v1:legacy:realm',
        name: 'Prefix Legacy Realm',
        scope: 'work',
      });
      await harness.engine.createMemorySession({ id: 'memory_session_attachment' });
      await harness.engine.attachMemoryRealmToSession({
        session_id: 'memory_session_attachment',
        realm_id: 'v1:legacy:realm',
        access: 'read_only',
        instructions: 'Legacy target id happens to start with the encoded prefix.',
      });

      const result = await resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'memory_session_attachment',
        target_id: 'memory_session_attachment:v1:legacy:realm',
      });

      expect(result).toEqual({
        target_kind: 'memory_session_attachment',
        target_id: 'memory_session_attachment:v1:legacy:realm',
        target_snapshot_hash: hashCanonicalJson({
          session_id: 'memory_session_attachment',
          realm_id: 'v1:legacy:realm',
          access: 'read_only',
          instructions: 'Legacy target id happens to start with the encoded prefix.',
        }),
        hash_source: 'canonical_json',
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('prefix-shaped attachment target ids throw when encoded and legacy rows both match', async () => {
    const harness = await createSqliteHarness();
    try {
      await harness.engine.upsertMemoryRealm({
        id: 'b',
        name: 'Encoded Realm',
        scope: 'work',
      });
      await harness.engine.upsertMemoryRealm({
        id: 'v1:a:b',
        name: 'Legacy Prefix Realm',
        scope: 'work',
      });
      await harness.engine.createMemorySession({ id: 'a' });
      await harness.engine.createMemorySession({ id: 'memory_session_attachment' });
      await harness.engine.attachMemoryRealmToSession({
        session_id: 'a',
        realm_id: 'b',
        access: 'read_write',
      });
      await harness.engine.attachMemoryRealmToSession({
        session_id: 'memory_session_attachment',
        realm_id: 'v1:a:b',
        access: 'read_only',
      });

      await expect(resolveTargetSnapshotHash(harness.engine, {
        target_kind: 'memory_session_attachment',
        target_id: 'memory_session_attachment:v1:a:b',
      })).rejects.toThrow(/ambiguous memory_session_attachment target_id/i);
    } finally {
      await harness.cleanup();
    }
  });

  test('SQLite and PGLite produce identical hashes for representative non-page records', async () => {
    const sqlite = await createSqliteHarness();
    const pglite = await createPgliteHarness();
    try {
      await seedRepresentativeTargets(sqlite.engine);
      await seedRepresentativeTargets(pglite.engine);

      const targets: Array<{ target_kind: MemoryMutationTargetKind; target_id: string }> = [
        { target_kind: 'memory_realm', target_id: 'realm:snapshot' },
        { target_kind: 'memory_session', target_id: 'session-snapshot' },
        { target_kind: 'memory_session_attachment', target_id: 'session-snapshot:realm:snapshot' },
        { target_kind: 'profile_memory', target_id: 'profile:snapshot' },
        { target_kind: 'personal_episode', target_id: 'episode:snapshot' },
        { target_kind: 'memory_candidate', target_id: 'candidate:snapshot' },
        { target_kind: 'task_thread', target_id: 'task:snapshot' },
        { target_kind: 'working_set', target_id: 'task:snapshot' },
        { target_kind: 'context_map', target_id: 'context-map:snapshot' },
        { target_kind: 'context_atlas', target_id: 'context-atlas:snapshot' },
      ];

      for (const target of targets) {
        const sqliteHash = await resolveTargetSnapshotHash(sqlite.engine, target);
        const pgliteHash = await resolveTargetSnapshotHash(pglite.engine, target);

        expect(sqliteHash).not.toBeNull();
        expect(pgliteHash).not.toBeNull();
        expect(sqliteHash).toEqual(pgliteHash);
        expect(sqliteHash?.target_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(sqliteHash?.hash_source).toBe('canonical_json');
      }
    } finally {
      await pglite.cleanup();
      await sqlite.cleanup();
    }
  });
});

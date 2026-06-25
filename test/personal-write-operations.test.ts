import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('safe personal write operations are registered with CLI hints', () => {
  const profileWrite = operations.find((operation) => operation.name === 'write_profile_memory_entry');
  const episodeWrite = operations.find((operation) => operation.name === 'write_personal_episode_entry');

  expect(profileWrite?.cliHints?.name).toBe('profile-memory-write');
  expect(episodeWrite?.cliHints?.name).toBe('personal-episode-write');
});

test('safe personal write operations create records only after personal write-target preflight allows them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const profileWrite = operations.find((operation) => operation.name === 'write_profile_memory_entry');
  const episodeWrite = operations.find((operation) => operation.name === 'write_personal_episode_entry');

  if (!profileWrite || !episodeWrite) {
    throw new Error('safe personal write operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const profile = await profileWrite.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'profile-1',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      profile_type: 'routine',
      query: 'remember my daily routine',
      source_ref: 'User, direct message, 2026-04-22 9:05 AM KST',
    });

    expect((profile as any).id).toBe('profile-1');
    expect((profile as any).scope_gate_policy).toBe('allow');
    expect((profile as any).scope_gate_reason).toBe('personal_signal');
    expect((profile as any).scope_gate).toMatchObject({ policy: 'allow', resolved_scope: 'personal' });
    expect((await engine.getProfileMemoryEntry('profile-1'))?.subject).toBe('daily routine');

    const deniedProfile = await profileWrite.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'profile-2',
      subject: 'architecture preference',
      content: 'Prefer reading docs before coding.',
      profile_type: 'preference',
      query: 'summarize the architecture docs',
      requested_scope: 'work',
      source_ref: 'User, direct message, 2026-04-22 9:10 AM KST',
    }).catch((error) => error);

    expect((deniedProfile as any).code).toBe('invalid_params');
    expect(await engine.getProfileMemoryEntry('profile-2')).toBeNull();

    const episode = await episodeWrite.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'episode-1',
      title: 'Morning reset',
      summary: 'Re-established the daily routine after travel.',
      source_kind: 'chat',
      start_time: '2026-04-22T06:30:00.000Z',
      end_time: '2026-04-22T07:00:00.000Z',
      query: 'remember my travel recovery routine',
      source_ref: 'User, direct message, 2026-04-22 9:15 AM KST',
      candidate_id: 'profile-1',
    });

    expect((episode as any).id).toBe('episode-1');
    expect((episode as any).scope_gate_policy).toBe('allow');
    expect((episode as any).scope_gate_reason).toBe('personal_signal');
    expect((episode as any).scope_gate).toMatchObject({ policy: 'allow', resolved_scope: 'personal' });
    expect((await engine.getPersonalEpisodeEntry('episode-1'))?.title).toBe('Morning reset');

    const deniedEpisode = await episodeWrite.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'episode-2',
      title: 'Architecture recap',
      summary: 'Summarized repo architecture notes.',
      source_kind: 'note',
      start_time: '2026-04-22T08:00:00.000Z',
      query: 'summarize the architecture docs',
      requested_scope: 'work',
      source_ref: 'User, direct message, 2026-04-22 9:20 AM KST',
    }).catch((error) => error);

    expect((deniedEpisode as any).code).toBe('invalid_params');
    expect(await engine.getPersonalEpisodeEntry('episode-2')).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal write operations expose scope-gate output and record apply audit events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-audit-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const cases = [
    {
      operation: 'upsert_profile_memory_entry',
      targetKind: 'profile_memory',
      id: 'audit-profile-legacy',
      params: {
        id: ' audit-profile-legacy ',
        subject: 'personal daily preference',
        content: 'Prefers a daily written plan.',
        profile_type: 'preference',
        source_ref: 'User, direct message, 2026-06-24 11:00 AM KST',
      },
    },
    {
      operation: 'write_profile_memory_entry',
      targetKind: 'profile_memory',
      id: 'audit-profile-safe',
      params: {
        id: 'audit-profile-safe',
        subject: 'personal writing routine',
        content: 'Writes before reading notifications.',
        profile_type: 'routine',
        query: 'remember my personal writing routine',
        source_ref: 'User, direct message, 2026-06-24 11:01 AM KST',
      },
    },
    {
      operation: 'record_personal_episode',
      targetKind: 'personal_episode',
      id: 'audit-episode-legacy',
      params: {
        id: 'audit-episode-legacy',
        title: 'Personal planning reset',
        start_time: '2026-06-24T02:00:00.000Z',
        source_kind: 'chat',
        summary: 'Reset the personal planning routine.',
        source_ref: 'User, direct message, 2026-06-24 11:02 AM KST',
      },
    },
    {
      operation: 'write_personal_episode_entry',
      targetKind: 'personal_episode',
      id: 'audit-episode-safe',
      params: {
        id: 'audit-episode-safe',
        title: 'Personal schedule review',
        start_time: '2026-06-24T02:30:00.000Z',
        source_kind: 'chat',
        summary: 'Reviewed the personal schedule after travel.',
        query: 'remember my personal schedule review',
        source_ref: 'User, direct message, 2026-06-24 11:03 AM KST',
      },
    },
  ] as const;

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    for (const entry of cases) {
      const operation = operations.find((candidate) => candidate.name === entry.operation);
      if (!operation) throw new Error(`missing operation: ${entry.operation}`);
      const dryRunId = `${entry.id}-dry-run`;
      const dryRunParams = { ...entry.params, id: dryRunId };

      const preview = await operation.handler({
        engine,
        config: {} as any,
        logger: console,
        dryRun: true,
      }, dryRunParams);

      expect((preview as any).dry_run).toBe(true);
      expect((preview as any).action).toBe(entry.operation);
      expect((preview as any).scope_id).toBe('personal:default');
      expect((preview as any).scope_gate_policy).toBe('allow');
      expect((preview as any).scope_gate_reason).toBeTruthy();
      expect((preview as any).scope_gate).toMatchObject({ policy: 'allow', resolved_scope: 'personal' });
      const dryRunPersisted = entry.targetKind === 'profile_memory'
        ? await engine.getProfileMemoryEntry(dryRunId)
        : await engine.getPersonalEpisodeEntry(dryRunId);
      expect(dryRunPersisted).toBeNull();
      expect(await engine.listMemoryMutationEvents({ operation: entry.operation as any })).toHaveLength(0);

      const applied = await operation.handler({
        engine,
        config: {} as any,
        logger: console,
        dryRun: false,
      }, entry.params);

      expect((applied as any).id).toBe(entry.id);
      expect((applied as any).scope_id).toBe('personal:default');
      expect((applied as any).scope_gate_policy).toBe('allow');
      expect((applied as any).scope_gate_reason).toBeTruthy();
      expect((applied as any).scope_gate).toMatchObject({ policy: 'allow', resolved_scope: 'personal' });
      expect((applied as any).mutation_event).toMatchObject({
        operation: entry.operation,
        target_kind: entry.targetKind,
        target_id: entry.id,
        scope_id: 'personal:default',
        result: 'applied',
        dry_run: false,
      });
      expect((applied as any).mutation_event.metadata).toMatchObject({
        scope_gate_policy: 'allow',
        scope_gate_reason: (applied as any).scope_gate_reason,
        personal_write_target_selection_reason: 'direct_personal_write_target',
      });
      expect((applied as any).mutation_event.metadata.scope_gate).toMatchObject({
        policy: 'allow',
        resolved_scope: 'personal',
      });

      const events = await engine.listMemoryMutationEvents({ operation: entry.operation as any });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        operation: entry.operation,
        target_kind: entry.targetKind,
        target_id: entry.id,
        scope_id: 'personal:default',
        result: 'applied',
        dry_run: false,
      });
      expect(events[0]?.metadata).toMatchObject({
        scope_gate_policy: 'allow',
        scope_gate_reason: (applied as any).scope_gate_reason,
      });
      expect(events[0]?.metadata.scope_gate).toMatchObject({
        policy: 'allow',
        resolved_scope: 'personal',
      });
    }
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal write operations reject explicit non-personal scope overrides before persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-scope-override-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const cases = [
    {
      operation: 'upsert_profile_memory_entry',
      targetKind: 'profile',
      params: (scopeId: string) => ({
        id: `profile-${scopeId.replace(/[^a-z0-9]+/gi, '-')}`,
        scope_id: scopeId,
        subject: `profile ${scopeId}`,
        content: 'This should never be persisted outside personal scope.',
        profile_type: 'stable_fact',
        source_ref: 'User, direct message, 2026-06-24 10:00 AM KST',
      }),
    },
    {
      operation: 'write_profile_memory_entry',
      targetKind: 'profile',
      params: (scopeId: string) => ({
        id: `safe-profile-${scopeId.replace(/[^a-z0-9]+/gi, '-')}`,
        scope_id: scopeId,
        subject: `safe profile ${scopeId}`,
        content: 'This should never be persisted outside personal scope.',
        profile_type: 'stable_fact',
        query: 'remember my personal preference',
        source_ref: 'User, direct message, 2026-06-24 10:01 AM KST',
      }),
    },
    {
      operation: 'record_personal_episode',
      targetKind: 'episode',
      params: (scopeId: string) => ({
        id: `episode-${scopeId.replace(/[^a-z0-9]+/gi, '-')}`,
        scope_id: scopeId,
        title: `episode ${scopeId}`,
        start_time: '2026-06-24T01:00:00.000Z',
        source_kind: 'chat',
        summary: 'This should never be persisted outside personal scope.',
        source_ref: 'User, direct message, 2026-06-24 10:02 AM KST',
      }),
    },
    {
      operation: 'write_personal_episode_entry',
      targetKind: 'episode',
      params: (scopeId: string) => ({
        id: `safe-episode-${scopeId.replace(/[^a-z0-9]+/gi, '-')}`,
        scope_id: scopeId,
        title: `safe episode ${scopeId}`,
        start_time: '2026-06-24T01:00:00.000Z',
        source_kind: 'chat',
        summary: 'This should never be persisted outside personal scope.',
        query: 'remember my personal episode',
        source_ref: 'User, direct message, 2026-06-24 10:03 AM KST',
      }),
    },
  ] as const;
  const rejectedScopeIds = ['work:default', 'work:acme', 'workspace:default', 'team:default'];

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    for (const entry of cases) {
      const operation = operations.find((candidate) => candidate.name === entry.operation);
      if (!operation) throw new Error(`missing operation: ${entry.operation}`);
      for (const scopeId of rejectedScopeIds) {
        for (const dryRun of [true, false]) {
          const params = entry.params(scopeId);
          await expect(operation.handler({
            engine,
            config: {} as any,
            logger: console,
            dryRun,
          }, params)).rejects.toThrow(/personal: scope/);

          const persisted = entry.targetKind === 'profile'
            ? await engine.getProfileMemoryEntry(params.id)
            : await engine.getPersonalEpisodeEntry(params.id);
          expect(persisted).toBeNull();
          expect(await engine.listMemoryMutationEvents({ operation: entry.operation as any })).toHaveLength(0);
        }
      }
    }
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

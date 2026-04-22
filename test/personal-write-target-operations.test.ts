import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('personal write target operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'select_personal_write_target');
  expect(route?.cliHints?.name).toBe('personal-write-target');
});

test('personal write target operation returns allow, deny, and defer disclosures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-target-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'select_personal_write_target');

  if (!route) {
    throw new Error('select_personal_write_target operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const allow = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      target_kind: 'profile_memory',
      subject: 'daily routine',
      query: 'remember my daily routine',
    });

    expect((allow as any).selection_reason).toBe('direct_personal_write_target');
    expect((allow as any).route?.target_kind).toBe('profile_memory');

    const deny = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      target_kind: 'personal_episode',
      title: 'Morning reset',
      query: 'summarize the architecture docs',
      requested_scope: 'work',
    });

    expect((deny as any).selection_reason).toBe('unsupported_scope_intent');
    expect((deny as any).route).toBeNull();

    const defer = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      target_kind: 'profile_memory',
      subject: 'reference entry',
      query: 'help me remember this',
    });

    expect((defer as any).selection_reason).toBe('insufficient_signal');
    expect((defer as any).route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

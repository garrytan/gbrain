import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSchemaPack } from '../src/core/advisor/collect-schema-pack.ts';
import { SUBCOMMANDS as SCHEMA_SUBCOMMANDS } from '../src/commands/schema.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-pack-advisor-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test('schema-pack advisor suggests a schema subcommand the router accepts', async () => {
  const engine = { getConfig: async (k: string) => (k === 'schema_pack' ? 'missing-fixture-pack' : null) };
  let findings: any[] | undefined;
  let thrown: unknown;
  try {
    findings = await withEnv({ GBRAIN_HOME: home }, () =>
      collectSchemaPack.collect({ engine, remote: false, config: {}, now: new Date(0) } as any) as Promise<any[]>);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeUndefined();
  const finding = findings?.find((f) => f.id === 'schema_pack_unresolved');
  expect(finding).toBeDefined();
  const argv = finding?.fix?.command_argv ?? [];
  expect(argv.slice(0, 2)).toEqual(['gbrain', 'schema']);
  expect(SCHEMA_SUBCOMMANDS as readonly string[]).toContain(argv[2]);
});

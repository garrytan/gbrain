/** Source-local opt-in and connector identity must agree; no provider or real inbox. */
import { expect, test } from 'bun:test';
import { parseGoogleSourceConfig } from '../src/core/google/source-config.ts';
import { connectorIdentity } from '../src/core/persistence/connector-identity.ts';

test('automated import is explicit and local to one source', () => {
  const parse = (value: unknown) => parseGoogleSourceConfig(value === undefined ? {} : { g_import_automated: value }, '/tmp/fixture');
  expect(parse(undefined).importAutomated).toBeUndefined();
  for (const value of [true, 'true', '1', 'on']) expect(parse(value).importAutomated).toBe(true);
  for (const value of [false, 'false', '0', 'unknown']) expect(parse(value).importAutomated).toBe(false);
  expect(parse(undefined).importAutomated).toBeUndefined();
});

test('only enabling automated import changes connector identity', () => {
  const identity = (config: Record<string, unknown>) => connectorIdentity('google', config, '/tmp/fixture').digest;
  const base = { g_account: 'fixture', g_services: 'gmail', g_history_days: 90 };
  expect(identity({ ...base, g_import_automated: false })).toEqual(identity(base));
  expect(identity({ ...base, g_import_automated: true })).not.toEqual(identity(base));
});

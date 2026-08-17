import { describe, expect, test } from 'bun:test';
import { schemaVersionHealth } from '../src/core/schema-version-health.ts';

describe('schemaVersionHealth', () => {
  test('accepts only an exact schema match', () => {
    expect(schemaVersionHealth(130, 130)).toEqual({
      status: 'ok',
      message: 'Version 130 (latest: 130)',
    });
  });

  test('flags a database newer than the client as unsafe', () => {
    expect(schemaVersionHealth(130, 125)).toEqual({
      status: 'fail',
      message:
        "Database schema version 130 is newer than this client's latest 125. " +
        'Upgrade gbrain before performing writes; do not run migrations with this client.',
    });
  });

  test('retains the existing missing and behind guidance', () => {
    expect(schemaVersionHealth(0, 130).status).toBe('fail');
    expect(schemaVersionHealth(125, 130)).toEqual({
      status: 'warn',
      message: 'Version 125, latest is 130. Fix: gbrain apply-migrations --yes',
    });
    expect(schemaVersionHealth(125, 130, { remote: true })).toEqual({
      status: 'warn',
      message: 'Version 125, latest is 130. Run `gbrain apply-migrations --yes` on the host.',
    });
  });
});

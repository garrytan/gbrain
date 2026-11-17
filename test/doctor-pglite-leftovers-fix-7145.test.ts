/**
 * #7145: pglite_leftovers names the exact cleanup for the legacy copier's old store, not only a graduation copy:
 * a size preview (du -sh) and a consent-gated delete (fix argv rm -rf <path>, consent destructive, asked of the user).
 * Synthetic foresights home under the OS temp dir; nothing is deleted.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { homeDirInWorktreeEntry } from '../src/commands/doctor/checks/local-audits.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-7145-leftovers-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('pglite_leftovers cleanup command', () => {
  test('the old brain.pglite store gets a preview and a consent-gated delete of exactly that path', async () => {
    const gbrain = join(home, '.gbrain');
    const store = join(gbrain, 'brain.pglite');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'PG_VERSION'), 'x'.repeat(4096));
    writeFileSync(join(gbrain, 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://alice-example@db.acme-example.test:5432/brain' }));
    const checks = (await withEnv({ GBRAIN_HOME: home, GBRAIN_GRADUATION_RUN: undefined, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined },
      () => homeDirInWorktreeEntry.run({} as DoctorContext))) as Check[];
    const check = checks.find(c => c.name === 'pglite_leftovers')!;
    expect(check.status).toBe('warn');
    expect(check.fix).toMatchObject({ argv: ['rm', '-rf', store], consent: ['destructive'], actor: 'agent',
      verify: { argv: ['gbrain', 'doctor', '--only', 'pglite_leftovers', '--json'] } });
    expect(String((check.fix as { user_message?: string }).user_message)).toContain(store);
    expect(check.details).toMatchObject({ preview: ['du', '-sh', store], leftovers: [expect.objectContaining({ path: store })] });
    expect(check.message).toContain(`du -sh ${store}`);
    expect(check.message).toContain(`rm -rf ${store}`);
  });
});

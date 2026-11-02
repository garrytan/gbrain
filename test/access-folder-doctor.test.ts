/**
 * GBRA-218 (A2) folder-rule doctor checks on a repo-less PGLite brain:
 * access_policy_pending, access_policy_widening_held, access_policy_invalid and
 * access_policy_store_mismatch each find their case, carry a fix whose verify
 * is the read-only check, clear once fixed, and are not applicable on a brain
 * where no source has a folder rule.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { folderAccessEntry } from '../src/commands/doctor/checks/folder-access.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { markPolicyInvalid, clearPolicyInvalid, policySeams, proposeRevision, resumePolicy, writeAccessStore } from '../src/core/access/policy.ts';

const SRC = 'fd-team';
const page = (title: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Body.'].join('\n');
const rule = (id: string, prefix: string, readers: string[]) => ({ id, prefix, readable_by: readers });

describe('folder-rule doctor checks (pglite, repo-less)', () => {
  let engine: BrainEngine;
  const run = async () => Object.fromEntries((await folderAccessEntry.run({ engine } as unknown as DoctorContext) as Array<{ name: string }>).map(c => [c.name, c])) as Record<string, any>;

  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    await importFromContent(engine, 'partners/alice-example/plan', page('Plan'), { sourceId: SRC, noEmbed: true });
  }, 120_000);
  afterAll(async () => { policySeams.afterInstall = undefined; await engine.disconnect(); });

  test('no folder rule: every check is not applicable', async () => {
    const checks = await run();
    expect(Object.keys(checks).sort()).toEqual(['access_policy_invalid', 'access_policy_pending', 'access_policy_store_mismatch', 'access_policy_widening_held']);
    for (const c of Object.values(checks)) expect(c).toMatchObject({ status: 'ok', readiness_state: 'not_applicable' });
  }, 60_000);

  test('a narrowing interrupted mid-apply is pending until resume', async () => {
    policySeams.afterInstall = () => { throw new Error('interrupted'); };
    try { await expect(proposeRevision(engine, SRC, [rule('alice', 'partners/alice-example/', ['member:alice-example'])], { origin: 'cli', store: 'database' })).rejects.toThrow('interrupted'); }
    finally { policySeams.afterInstall = undefined; }
    const c = (await run()).access_policy_pending;
    expect(c).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'access', 'resume', '--source', SRC], verify: { argv: ['gbrain', 'doctor', '--only', 'access_policy_pending', '--json'] } } });
    expect(c.details.sources[0]).toMatchObject({ source: SRC, prefixes: ['partners/alice-example/'], drifted: 1 });
    await resumePolicy(engine, SRC);
    expect((await run()).access_policy_pending.status).toBe('ok');
  }, 60_000);

  test('a held widening names the revision and previews with apply', async () => {
    await proposeRevision(engine, SRC, [], { origin: 'cli' });
    const c = (await run()).access_policy_widening_held;
    expect(c).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'access', 'apply', '--source', SRC, '--json'], ask_user: true } });
    expect(c.details.sources[0].changes).toEqual(['removed alice (partners/alice-example/)']);
    await proposeRevision(engine, SRC, [rule('alice', 'partners/alice-example/', ['member:alice-example'])], { origin: 'revert' });
    expect((await run()).access_policy_widening_held.status).toBe('ok');
  }, 60_000);

  test('an invalid policy file fails until cleared', async () => {
    await markPolicyInvalid(engine, SRC, ['hr/'], { problems: [{ line: 4, message: 'bad' }] });
    expect((await run()).access_policy_invalid).toMatchObject({ status: 'fail', details: { sources: [{ source: SRC, prefixes: ['hr/'] }] } });
    await clearPolicyInvalid(engine, SRC);
    expect((await run()).access_policy_invalid.status).toBe('ok');
  }, 60_000);

  test('a git store with no visible work tree is a store mismatch, fixed by a migrate preview', async () => {
    expect((await run()).access_policy_store_mismatch.status).toBe('ok');
    await writeAccessStore(engine, SRC, 'git');
    expect((await run()).access_policy_store_mismatch).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'access', 'rule', 'migrate', '--source', SRC, '--json'], ask_user: true } });
    await writeAccessStore(engine, SRC, 'database');
  }, 60_000);
});

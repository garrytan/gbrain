/**
 * #6712 PR 4b (design v3.2 §4): a managed sync pass admits at most `PASS_KEEP_DB_MAX` keep_db (database-wins) writes; the
 * rest settle as `keep_db_pending` (owned by sync, action `owner`) and the next pass admits them first. Seeded above
 * the cap on PGLite: `PASS_KEEP_DB_MAX + 1` pages under a `storage.keep_db` prefix, each edited in the database only.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { PASS_KEEP_DB_MAX } from '../src/core/persistence/sync-pass-apply.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const SLUGS = Array.from({ length: PASS_KEEP_DB_MAX + 1 }, (_, i) => `notes/n${String(i).padStart(3, '0')}`);
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  commit(root, 'notes');
};
async function databaseOnlyEdits(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  const ids: string[] = [];
  for (const slug of SLUGS) {
    const requestId = randomUUID(); ids.push(requestId);
    const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: current!.revision, content: note(slug, `The database-only edit of ${slug}.`) } });
  }
  await waitFor(async () => Number((await engine.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM persistence_requests WHERE request_id=ANY($1::uuid[]) AND state='committed'", [ids]))[0]!.n) === ids.length,
    { timeoutMs: 120_000, label: 'every database-only put_page commits' });
}
const telemetry = async (engine: BrainEngine) => (await engine.executeRaw<{ t: { counts: Record<string, number>; classes?: Record<string, { count: number; action: string }> } }>(
  "SELECT completed_keys->0->'telemetry' AS t FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'='default'", [MANAGED_SYNC_PASS_OP]))[0]!.t;

describe('#6712 PR 4b: keep_db writes per pass', () => {
  test(`a pass admits at most PASS_KEEP_DB_MAX (${PASS_KEEP_DB_MAX}) keep_db writes, the rest wait as keep_db_pending, and the next pass admits them`, () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdits(engine, ctx);
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - notes/\n'); commit(root, 'keep_db');
    expect((await performManagedSync(engine, OPTS)).held ?? []).toEqual([]);
    // counts.keep_db_pending counts deferrals across the round's re-reads; the class counts the paths left waiting.
    const first = await telemetry(engine);
    expect(first.counts.keep_db_admitted).toBe(PASS_KEEP_DB_MAX);
    expect(first.counts.keep_db_pending).toBeGreaterThan(0);
    expect(first.classes?.keep_db_pending).toEqual({ count: 1, action: 'owner' });
    await performManagedSync(engine, OPTS);
    const second = await telemetry(engine);
    expect(second.counts).toMatchObject({ keep_db_admitted: 1, keep_db_pending: 0 });
    expect((await engine.getPage(SLUGS.at(-1)!, { sourceId: 'default' }))?.compiled_truth).toContain('The database-only edit of ' + SLUGS.at(-1) + '.');
    expect(second.classes?.keep_db_pending).toBeUndefined();
  }, { setup }), 600_000);
});

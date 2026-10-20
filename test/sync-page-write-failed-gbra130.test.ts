/**
 * GBRA-130 A-6 (#6712 PR 4b): one page request of a managed sync that ends with an error the terminal classifier cannot
 * place (an owner exception such as Postgres 54000 from a frontmatter tag over the btree row limit, a TypeError in the
 * preparer, an unknown code) classified `systemic`: the run stopped `blocked_by_failures` at that entry and every later
 * sync stopped at the same entry again, so the rest of the source never imported.
 *
 * Protects (red before: every sync is `blocked_by_failures` at b.md, c.md never imports):
 * - the entry is held per path (`page_write_failed`, needs a human, the owner error as its reason) once the run re-froze
 *   it `STOPS_PER_ENTRY` times with the same fault, and the rest of the source imports;
 * - a later sync is not blocked by it.
 * Two triggers: a real 3000-character frontmatter tag (Postgres: btree 54000; PGLite has no such limit, so the PGLite
 * twin injects the same owner exception), and a TypeError thrown at `consumer:preparing` for b.md's requests.
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, extra = '') => `---\ntype: concept\ntitle: ${title}\n${extra}---\n\nThe body of ${title}.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
/** Incompressible, so its btree index tuple stays over the 2704-byte row limit. */
const LONG_TAG = randomBytes(1500).toString('hex');
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/seed.md'), note('notes/seed'));
  commit(root, 'seed');
};
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const ownerError = () => Object.assign(new Error('index row size 3056 exceeds btree version 4 maximum 2704 for index "idx_tags_tag"'), { code: '54000' });

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) describe(`[${backend}] GBRA-130 A-6: one page's unclassifiable write failure`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  for (const trigger of ['long tag', 'TypeError at preparation'] as const) test(`${trigger}: b.md is held page_write_failed, a.md and c.md import, and later syncs are not blocked`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a'));
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', trigger === 'long tag' ? `tags:\n  - ${LONG_TAG}\n` : ''));
    writeFileSync(join(root, 'notes/c.md'), note('notes/c'));
    commit(root, 'a b c');
    // PGLite has no btree row limit: its twin raises the owner exception Postgres raises, from inside b.md's publication.
    const injectOwner = trigger === 'long tag' && engine.kind !== 'postgres';
    // b.md's requests, read at claim (outside any transaction: a PGLite read inside the publication transaction would wait on it).
    const bRequests = new Set<string>();
    installFaultHook(async (point, detail) => {
      if (detail.operation !== 'submit_job' || !detail.requestId) return;
      if (point === 'consumer:preparing') {
        const [req] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1::uuid', [detail.requestId]);
        if (req?.slug === 'notes/b') bRequests.add(detail.requestId);
      }
      if (!bRequests.has(detail.requestId)) return;
      if (trigger === 'TypeError at preparation' && point === 'consumer:preparing') throw new TypeError("Cannot read properties of undefined (reading 'example')");
      if (injectOwner && point === 'publication:before_commit') throw ownerError();
    });
    const statuses: string[] = [];
    for (let run = 0; run < 4; run++) statuses.push((await performManagedSync(engine, OPTS)).status);
    expect(await live(engine)).toEqual(['notes/a', 'notes/c', 'notes/seed']);
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const hold = await readGitHold(engine, 'default', incarnation, 'notes/b.md');
    expect(hold).toMatchObject({ code: 'page_write_failed' });
    // One occurrence still stops the run (a transient defect never holds a file); the third identical failure holds the path.
    expect(statuses.slice(0, 2)).toEqual(['blocked_by_failures', 'blocked_by_failures']);
    expect(statuses.slice(2)).not.toContain('blocked_by_failures');
    installFaultHook(undefined);
  }, { databaseUrl, setup }), 240_000);
});

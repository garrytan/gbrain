/**
 * The shared fixture of the enforced member mode suites (GST-2476 G2): one repo-less brain on disk (PGLite, or one
 * isolated Postgres database), seeded with pages each member can or cannot read, and a spawner that runs the real
 * src/cli.ts as a child under GBRAIN_ENFORCED_MEMBER in a temp GBRAIN_HOME.
 *
 * Each suite file that calls enforcedMemberBrain() inside its describe gets its own brain, seeded the same way, so a
 * file never sees another file's writes. Used by test/enforced-member.serial.test.ts (reads and refusals),
 * test/enforced-member-writes.serial.test.ts (writes) and test/enforced-member-writes-setting.serial.test.ts
 * (access.enforced_member_writes).
 */
import { afterAll, beforeAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../../src/core/engine-factory.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { TestBackend } from './test-backends.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';

export const CLI = join(resolve(import.meta.dir, '..', '..'), 'src', 'cli.ts');
export const MEMBER = 'alice-example';
export const OWNER = 'owner-example';
export const FIRST = (who: string, command: string) => 'gbrain: refused under GBRAIN_ENFORCED_MEMBER=' + who + ': ' + command + ' [GBRAIN_ENFORCED_REFUSED]';
export const NOTICE = 'gbrain: results limited to what GBRAIN_ENFORCED_MEMBER=' + MEMBER + ' may read';
export const REMEMBER_FIRST = 'gbrain: refused under GBRAIN_ENFORCED_MEMBER=' + MEMBER + ': remember saves a fact only with --entity <slug of a page you can read>; nothing was saved [GBRAIN_ENFORCED_REFUSED]';
export const WRITES_OFF_FIRST = 'gbrain: refused under GBRAIN_ENFORCED_MEMBER=' + MEMBER + ': writes are off for members on this brain; nothing was saved [GBRAIN_ENFORCED_REFUSED]';
export const REMEMBER_RETRY = 'Retry: gbrain remember "<one fact>" --entity <exact slug of a page you can read, from gbrain find or gbrain search> --provenance "<where you learned it>"';

export const PAGES = {
  open: { slug: 'notes/open-example', title: 'Open example plan', canary: 'canaryemopen', fm: {} as Record<string, unknown>, source: 'default' },
  mine: { slug: 'notes/alice-example-plan', title: 'Alice example plan', canary: 'canaryemmine', fm: { readable_by: [MEMBER] }, source: 'default' },
  team: { slug: 'team-a/roadmap-example', title: 'Team a roadmap', canary: 'canaryemteam', fm: {}, source: 'default' },
  other: { slug: 'notes/bob-example-plan', title: 'Bob example secret', canary: 'canaryemother', fm: { readable_by: ['bob-example'] }, source: 'default' },
  priv: { slug: 'notes/quiet-example', title: 'Quiet example memo', canary: 'canaryempriv', fm: { visibility: 'private' }, source: 'default' },
  folder: { slug: 'team-b/budget-example', title: 'Team b budget', canary: 'canaryemfolder', fm: {}, source: 'default' },
  personal: { slug: 'notes/dm-example', title: 'Direct example thread', canary: 'canaryempersonal', fm: {}, source: 'bob-dm' },
} as const;
export type Key = keyof typeof PAGES;
export const VISIBLE: Key[] = ['open', 'mine', 'team'];
export const HIDDEN: Key[] = ['other', 'priv', 'folder', 'personal'];
export const HIDDEN_FACT = 'canaryemfacthidden';
export const OPEN_FACT = 'canaryemfactopen';
export const HIDDEN_MARKS = [...HIDDEN.flatMap(k => [PAGES[k].slug, PAGES[k].title, PAGES[k].canary]), HIDDEN_FACT];
export const leaks = (text: string) => HIDDEN_MARKS.filter(m => text.toLowerCase().includes(m.toLowerCase()));

export interface EnforcedMemberBrain {
  /** The temp directory holding the brain, its GBRAIN_HOME and any scratch files a case writes. */
  readonly root: string;
  /** A read-scope token bound to OWNER, for reading back what a member wrote. */
  readonly ownerToken: string;
  cli(args: string[], opts?: { member?: string | null; stdin?: string; env?: Record<string, string>; preload?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T>;
}

/** Registers the brain's beforeAll / afterAll in the calling describe and returns its handles. */
export function enforcedMemberBrain(kind: TestBackend): EnforcedMemberBrain {
  let root = '', home = '';
  let config: Record<string, unknown>;
  let closePg: (() => Promise<void>) | null = null;
  let ownerToken = '';

  function env(extra: Record<string, string | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
    for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'GBRAIN_ENFORCED_MEMBER']) delete out[k];
    const merged: Record<string, string | undefined> = { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_CLI_SOCKET: '0', ...extra };
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Record<string, string>;
  }
  async function cli(args: string[], opts: { member?: string | null; stdin?: string; env?: Record<string, string>; preload?: string } = {}) {
    const member = opts.member === undefined ? MEMBER : opts.member;
    const proc = Bun.spawn(['bun', 'run', ...(opts.preload ? ['--preload', opts.preload] : []), CLI, ...args], { cwd: root, env: env({ GBRAIN_ENFORCED_MEMBER: member ?? undefined, ...opts.env }),
      stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }
  async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const engine = await createEngine(config as never);
    await engine.connect(config as never);
    try { return await run(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-enforced-'));
    home = join(root, 'home');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    if (kind === 'postgres') {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      await pg.engine.disconnect();
      config = { engine: 'postgres', database_url: pg.databaseUrl };
      closePg = pg.close;
    } else {
      config = { engine: 'pglite', database_path: join(root, 'db') };
    }
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    await withBrain(async engine => {
      if (kind === 'pglite') await engine.initSchema();
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('bob-dm', 'bob-dm', '{\"federated\": true}'::jsonb) ON CONFLICT (id) DO NOTHING");
      for (const id of [MEMBER, 'bob-example', OWNER]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-a'), ('team-b') ON CONFLICT DO NOTHING");
      await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-a', $1), ('team-b', 'bob-example')", [MEMBER]);
      await engine.executeRaw("INSERT INTO access_member_sources (member_id, source_id) VALUES ('bob-example', 'bob-dm')");
      await proposeRevision(engine, 'default', [
        { id: 'team-a', prefix: 'team-a/', readable_by: ['group:team-a'] },
        { id: 'team-b', prefix: 'team-b/', readable_by: ['group:team-b'] },
      ] as never, { origin: 'cli', store: 'database' } as never);
      for (const key of Object.keys(PAGES) as Key[]) {
        const p = PAGES[key];
        const fm = Object.entries(p.fm).map(([k, v]) => k + ': ' + JSON.stringify(v)).join('\n');
        await importFromContent(engine, p.slug, '---\ntype: note\ntitle: ' + JSON.stringify(p.title) + '\n' + (fm ? fm + '\n' : '') + '---\n# ' + p.title + '\n\nHarbor ledger planning notes ' + p.canary + ' for the roadmap.\n', { sourceId: p.source, noEmbed: true });
      }
      await engine.addLink(PAGES.open.slug, PAGES.other.slug, 'see the secret plan', 'mentions');
      await engine.addLink(PAGES.other.slug, PAGES.open.slug, 'back to open', 'mentions');
      await engine.addTimelineEntry(PAGES.other.slug, { date: '2026-01-02', summary: 'Hidden event ' + HIDDEN_FACT } as never, { sourceId: 'default' });
      await engine.insertFact({ fact: 'Harbor ledger fact ' + HIDDEN_FACT, entity_slug: PAGES.other.slug, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
      await engine.insertFact({ fact: 'Harbor ledger fact ' + OPEN_FACT, entity_slug: PAGES.open.slug, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
      const minted = await mintLegacyToken(engine, { name: 'owner-key', scopes: ['read'], takesHolders: ['world'] } as never);
      ownerToken = minted.token;
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OWNER });
      await setOwner(engine, OWNER);
    });
  }, 240_000);

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await closePg?.();
  }, 60_000);

  return { get root() { return root; }, get ownerToken() { return ownerToken; }, cli, withBrain };
}

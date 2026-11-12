/**
 * GST-363 (PR 1): `gbrain setup <harness> --serves several` labels each person, and doctor checks it.
 *
 * 1. Protects: on a brain that serves several people every person gets a member, a folder rule people/<member>/ only
 *    that member reads, and one key bound to that member in a 0600 file outside any git tree; a read through that
 *    key sees its own folder plus world pages and never another member's folder. Re-runs keep everything (no key is
 *    ever replaced on its own), a partial failure converges on the next run, a plain one-person setup is unchanged
 *    on a one-person brain and refuses on a brain that serves several people, and doctor fails an unlabeled people
 *    folder until a rule names its readers. The brain-first text says the connection is already scoped.
 * 2. Fails when: a member's key reads another member's folder, a re-run mints a second key or rewrites a key file, a
 *    key value reaches the receipt, a key file is group- or world-readable or lands in a checkout, an empty roster
 *    writes anything, the default setup output changes, or an unbound connection is written on a several brain.
 * 3. Existing coverage: setup.test.ts (the one-person install), access-folder-rules*.test.ts (the rule path),
 *    member-read-access.test.ts (bound reads).
 * 4. Real seams: the minted key verified by the serve --http verifier and dispatched remote=true (PGLite repo-less,
 *    Postgres when DATABASE_URL is set); `bun src/cli.ts setup` spawned against a temp HOME / GBRAIN_HOME; a real
 *    git repository for the repo-brain arm.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { labelSeveral, receiptOk, servesStatus, type ServesReceipt } from '../src/commands/access-serves.ts';
import { setupRerunArgv } from '../src/core/setup/launcher-lanes.ts';
import { servesPreflight } from '../src/commands/setup-serves.ts';
import { refreshHookLaunchers } from '../src/core/setup/hook-launcher-refresh.ts';
import { ownedEntryFingerprint } from '../src/core/bootstrap/adopted-connections.ts';
import { readdirSync } from 'node:fs';
import { addMember } from '../src/core/access/members.ts';
import { unlabeledPeopleFoldersEntry } from '../src/commands/doctor/checks/unlabeled-people-folders.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { addFolderRules } from '../src/commands/access-rules.ts';
import { renderBrainFirstBlock, renderBrainFirstTurnRule, SERVES_SEVERAL_LINE } from '../src/core/setup/brain-first.ts';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const ROSTER = ['alice-example', 'bob-example'];
const PAGES: Record<string, string> = {
  'people/alice-example/plan': 'alicecanary',
  'people/bob-example/plan': 'bobcanary',
  'people/carol-public': 'carolcanary',
  'notes/world-topic': 'worldcanary',
};
const pageText = (slug: string, canary: string) => `---\ntype: note\ntitle: ${slug}\n---\n# ${slug}\n\nHarbor ledger notes ${canary}.\n`;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe('brain-first text for the two shapes', () => {
  test('one person keeps the source_ids / own-access-rules lines; several says the connection is already scoped', () => {
    const one = renderBrainFirstBlock('claude-code', { kind: 'mcp', server: 'gbrain', surface: 'starter' });
    const several = renderBrainFirstBlock('claude-code', { kind: 'mcp', server: 'gbrain', surface: 'starter', serves: 'several' });
    expect(one).toContain('Pass `source_ids` to narrow a request to what the current requester may see, and apply your own access rules to what comes back.');
    expect(one).not.toContain(SERVES_SEVERAL_LINE);
    expect(several).toContain(`- ${SERVES_SEVERAL_LINE}`);
    expect(several).not.toMatch(/source_ids|apply your own access rules/);
    expect(several.split('\n').length).toBe(one.split('\n').length);
    expect(renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain', surface: 'verbs' })).toContain('Results span every source it holds: use only what the current requester may see.');
    expect(renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain', surface: 'verbs', serves: 'several' })).toContain(SERVES_SEVERAL_LINE);
  });
});

for (const kind of testBackends()) {
  describe(`labelling several people (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const label = (roster: string[], env: Record<string, string | undefined> = {}) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined, ...env }, () => labelSeveral(engine, roster, 'default', true, true));
    const doctor = async () => (await unlabeledPeopleFoldersEntry.run({ engine } as unknown as DoctorContext) as Array<Record<string, any>>)[0]!;

    /** The canaries a keyword search through `member`'s key file returns, read remotely as the serve --http verifier does. */
    async function boundSearch(member: string): Promise<string[]> {
      const token = readFileSync(join(home, '.gbrain', 'member-keys', `${member}.key`), 'utf8').trim();
      const auth = await provider().verifyAccessToken(token) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, 'search', { query: 'harbor ledger notes', match: 'keyword', fields: 'full', limit: 20 }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
      const text = out.content.map(c => c.text).join('\n');
      return Object.values(PAGES).filter(c => text.includes(c)).sort();
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      home = tempDir('gbrain-serves-');
      for (const [slug, canary] of Object.entries(PAGES)) await importFromContent(engine, slug, pageText(slug, canary), { sourceId: 'default', noEmbed: true });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('doctor: not applicable for one person, fails each unlabeled people folder once the brain serves several', async () => {
      expect(await doctor()).toMatchObject({ name: 'unlabeled_people_folders', status: 'ok', readiness_state: 'not_applicable' });
      await engine.setConfig('access.serves', 'several');
      const c = await doctor();
      expect(c.status).toBe('fail');
      expect(c.details.folders).toEqual([
        { source: 'default', prefix: 'people/alice-example/', pages: 1 },
        { source: 'default', prefix: 'people/bob-example/', pages: 1 },
      ]);
      expect(c.fix).toMatchObject({ argv: ['gbrain', 'access', 'rule', 'add', '--prefix', 'people/alice-example/', '--readers', 'alice-example', '--source', 'default'], ask_user: true });
      await engine.unsetConfig('access.serves');
    }, 60_000);

    test('labels each person: members, folder rules, a bound read-write key per member in a 0600 file outside git', async () => {
      const r = await label(ROSTER);
      expect(r.error).toBeUndefined();
      expect(r.completed).toEqual(['members', 'rules', 'keys', 'config']);
      expect(r.unlabeled).toEqual([]);
      expect(r.members.map(m => m.action)).toEqual(['add', 'add']);
      expect(r.rules.map(x => [x.prefix, x.readers, x.action])).toEqual([['people/alice-example/', ['member:alice-example'], 'add'], ['people/bob-example/', ['member:bob-example'], 'add']]);
      expect(r.rule_write).toMatchObject({ store: 'database', state: 'applied' });
      expect(await engine.getConfig('access.serves')).toBe('several');
      for (const k of r.keys) {
        expect(k.action).toBe('mint');
        expect(mode(k.path)).toBe('600');
        expect(mode(join(home, '.gbrain', 'member-keys'))).toBe('700');
        expect(readFileSync(k.path, 'utf8')).toMatch(/^gbrain_\S+\n$/);
        expect(JSON.stringify(r)).not.toContain(readFileSync(k.path, 'utf8').trim());
        const [row] = await engine.executeRaw<{ member_id: string; scopes: string[] }>('SELECT member_id, scopes FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [k.token_name]);
        expect(row).toMatchObject({ member_id: k.member, scopes: ['read', 'write'] });
      }
      expect(() => execFileSync('git', ['-C', join(home, '.gbrain', 'member-keys'), 'rev-parse', '--show-toplevel'], { stdio: 'ignore' })).toThrow();
    }, 60_000);

    test("a search through each member's key sees its own folder and world pages, never the other member's folder", async () => {
      expect(await boundSearch('alice-example')).toEqual(['alicecanary', 'carolcanary', 'worldcanary']);
      expect(await boundSearch('bob-example')).toEqual(['bobcanary', 'carolcanary', 'worldcanary']);
    }, 60_000);

    test('doctor passes once every people folder is labelled; a rule on people/ also counts', async () => {
      expect(await doctor()).toMatchObject({ status: 'ok' });
      await importFromContent(engine, 'people/dana-example/notes', pageText('people/dana-example/notes', 'danacanary'), { sourceId: 'default', noEmbed: true });
      expect((await doctor()).details.folders).toEqual([{ source: 'default', prefix: 'people/dana-example/', pages: 1 }]);
      await addFolderRules(engine, 'default', [{ id: 'people-dana-example', prefix: 'people/dana-example/', readable_by: ['member:alice-example'] }], { apply: true, json: true });
      expect(await doctor()).toMatchObject({ status: 'ok' });
    }, 60_000);

    test('a re-run keeps everything and never replaces a key', async () => {
      const before = Object.fromEntries(ROSTER.map(m => [m, readFileSync(join(home, '.gbrain', 'member-keys', `${m}.key`), 'utf8')]));
      const r = await label(ROSTER);
      expect(r.error).toBeUndefined();
      expect([r.config.action, ...r.members.map(m => m.action), ...r.rules.map(x => x.action), ...r.keys.map(k => k.action)]).toEqual(['keep', 'keep', 'keep', 'keep', 'keep', 'keep', 'keep']);
      expect(r.rule_write).toBeUndefined();
      for (const m of ROSTER) expect(readFileSync(join(home, '.gbrain', 'member-keys', `${m}.key`), 'utf8')).toBe(before[m]!);
      const [n] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM access_tokens WHERE name LIKE 'member-%' AND revoked_at IS NULL");
      expect(Number(n!.n)).toBe(2);
    }, 60_000);

    test('a partial failure reports what it finished, and the next run converges', async () => {
      const roster = [...ROSTER, 'erin-example', 'finn-example'];
      const stopped = await label(roster, { GBRAIN_SETUP_ABORT_AFTER: 'serves-key' });
      expect(stopped.error?.message).toContain('serves-key');
      expect(stopped.completed).toEqual(['members', 'rules']);
      const keyDir = join(home, '.gbrain', 'member-keys');
      expect(existsSync(join(keyDir, 'erin-example.key'))).toBe(true);
      expect(existsSync(join(keyDir, 'finn-example.key'))).toBe(false);
      const erin = readFileSync(join(keyDir, 'erin-example.key'), 'utf8');
      const again: ServesReceipt = await label(roster);
      expect(again.error).toBeUndefined();
      expect(again.keys.map(k => [k.member, k.action])).toEqual([['alice-example', 'keep'], ['bob-example', 'keep'], ['erin-example', 'keep'], ['finn-example', 'mint']]);
      expect(readFileSync(join(keyDir, 'erin-example.key'), 'utf8')).toBe(erin);
      expect(await boundSearch('finn-example')).toEqual(['carolcanary', 'worldcanary']);
    }, 60_000);

    test('a key whose file is gone is reported with the revoke step, never replaced on its own', async () => {
      const path = join(home, '.gbrain', 'member-keys', 'bob-example.key');
      unlinkSync(path);
      const r = await label(ROSTER);
      expect(r.keys.find(k => k.member === 'bob-example')).toMatchObject({ action: 'blocked' });
      expect(r.keys.find(k => k.member === 'bob-example')!.detail).toContain('gbrain auth revoke member-bob-example');
      expect(existsSync(path)).toBe(false);
    }, 60_000);
  });
}

describe('labelling refuses or reports what it cannot make safe (pglite, repo-less)', () => {
  let engine: BrainEngine;
  let home: string;
  const label = (roster: string[], gbrainHome?: string, sourceId = 'default') => withEnv({ GBRAIN_HOME: gbrainHome ?? home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(engine, roster, sourceId, true, true));
  const liveToken = async (name: string) => (await engine.executeRaw<{ source_grant: string }>('SELECT source_grant FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]))[0];
  const memberCount = async (id: string) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_members WHERE id = $1', [id]))[0]!.n);
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    home = tempDir('gbrain-serves-refuse-');
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('a key directory inside a git work tree, or linked into one, refuses before anything is written', async () => {
    const repo = tempDir('gbrain-serves-git-');
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, 'brain-home'));
    const linked = join(tempDir('gbrain-serves-link-'), 'home');
    symlinkSync(join(repo, 'brain-home'), linked);
    for (const gbrainHome of [repo, linked]) {
      await expect(label(['kim-example'], gbrainHome)).rejects.toMatchObject({ code: 'access_serves_key_dir_in_git' });
    }
    expect(await memberCount('kim-example')).toBe(0);
    expect(await engine.getConfig('access.serves')).toBeFalsy();
    expect(existsSync(join(repo, 'brain-home', '.gbrain', 'member-keys'))).toBe(false);
  }, 60_000);

  test('an existing rule that lets someone else read a folder blocks the whole run, and nothing is written', async () => {
    for (const m of ['lee-example', 'mia-example']) await addMember(engine, m);
    await addFolderRules(engine, 'default', [{ id: 'people-lee-example', prefix: 'people/lee-example/', readable_by: ['member:lee-example', 'member:mia-example'] }], { apply: true, json: true });
    const r = await label(['lee-example', 'mia-example']);
    expect(r.applied).toBe(false);
    expect(receiptOk(r)).toBe(false);
    expect(r.rules.find(x => x.prefix === 'people/lee-example/')).toMatchObject({ action: 'blocked' });
    expect(r.rules.find(x => x.prefix === 'people/lee-example/')!.detail).toContain('mia-example');
    expect(await liveToken('member-mia-example')).toBeUndefined();
    expect(await engine.getConfig('access.serves')).toBeFalsy();
  }, 60_000);

  test('a key file that does not hold the live key is BLOCKED, never reported as kept', async () => {
    expect((await label(['nia-example'])).keys[0]!.action).toBe('mint');
    writeFileSync(join(home, '.gbrain', 'member-keys', 'nia-example.key'), 'gbrain_notthelivekey\n', { mode: 0o600 });
    const r = await label(['nia-example']);
    expect(r.keys[0]).toMatchObject({ action: 'blocked' });
    expect(r.keys[0]!.detail).toContain('does not hold the live key member-nia-example');
  }, 60_000);

  test('a key file left by another brain or a revoked key is BLOCKED, never overwritten', async () => {
    const path = join(home, '.gbrain', 'member-keys', 'sam-example.key');
    mkdirSync(join(home, '.gbrain', 'member-keys'), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'gbrain_anotherbrainskey\n', { mode: 0o600 });
    const r = await label(['sam-example']);
    expect(r.keys[0]).toMatchObject({ action: 'blocked' });
    expect(r.keys[0]!.detail).toContain('move or delete the file');
    expect(readFileSync(path, 'utf8')).toBe('gbrain_anotherbrainskey\n');
    expect(await liveToken('member-sam-example')).toBeUndefined();
  }, 60_000);

  test('a key file that cannot be written revokes the key it just minted, and the next run mints a new one', async () => {
    const inTheWay = join(home, '.gbrain', 'member-keys', `oli-example.key.${process.pid}.tmp`);
    mkdirSync(join(inTheWay, 'x'), { recursive: true });
    const r = await label(['oli-example']);
    expect(r.error).toBeDefined();
    expect(r.completed).toEqual(['members', 'rules']);
    expect(await liveToken('member-oli-example')).toBeUndefined();
    rmSync(inTheWay, { recursive: true });
    const again = await label(['oli-example']);
    expect(again.error).toBeUndefined();
    expect(again.keys[0]!.action).toBe('mint');
  }, 60_000);

  test('keys minted for a named source are granted that source', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['team']);
    const r = await label(['pat-example'], undefined, 'team');
    expect(r.error).toBeUndefined();
    expect(await liveToken('member-pat-example')).toMatchObject({ source_grant: 'scalar' });
  }, 60_000);

  test('people folders no rule covers are reported, and the run is not ok', async () => {
    await importFromContent(engine, 'people/quinn-example/notes', pageText('people/quinn-example/notes', 'quinncanary'), { sourceId: 'default', noEmbed: true });
    const r = await label(['ray-example']);
    expect(r.error).toBeUndefined();
    expect(r.unlabeled).toEqual([{ source: 'default', prefix: 'people/quinn-example/', pages: 1 }]);
    expect(receiptOk(r)).toBe(false);
  }, 60_000);

  test('an owner or stdio member who is not an enabled member does not count as binding the connection', async () => {
    await engine.setConfig('access.owner_member', 'zed-example');
    await engine.setConfig('mcp.stdio_member', 'zed-example');
    expect(await servesStatus(engine)).toMatchObject({ owner: null, stdio_member: null });
  }, 60_000);
});

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
interface Box { root: string; home: string; bin: string }

function box(): Box {
  const root = tempDir('gbrain-setup-serves-');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}
const gbrain = (b: Box, args: string[], env: Record<string, string | undefined> = {}) => runCli(args, { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home, OPENCLAW_STATE_DIR: join(b.root, 'openclaw-state'), OPENCLAW_PROFILE: undefined, HERMES_HOME: join(b.root, 'hermes-home'), ...env }, timeoutMs: 120_000 });
async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await gbrain(b, ['setup', ...args, '--gbrain-bin', b.bin]);
  let doc: any = null;
  if (args.includes('--json')) { try { doc = JSON.parse(r.stdout); } catch { doc = null; } }
  return { ...r, doc };
}
async function brainWithPages(b: Box): Promise<void> {
  expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  for (const [slug, canary] of Object.entries(PAGES)) expect((await gbrain(b, ['put', slug, '--content', pageText(slug, canary)])).exitCode).toBe(0);
}
const entry = (b: Box) => JSON.parse(readFileSync(join(b.home, '.claude.json'), 'utf8')).mcpServers.gbrain as { command: string; args: string[] };
const entryArgs = (b: Box) => entry(b).args;
/** setup's claude-code entry as it was before the launcher (#8426), still owned by its receipt, so post-upgrade rewrites it. */
function staleEntry(b: Box): void {
  const cfgPath = join(b.home, '.claude.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.mcpServers.gbrain = { ...cfg.mcpServers.gbrain, command: b.bin };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const receiptPath = join(b.home, '.gbrain-connection-claude-code-gbrain.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, entry_hash: ownedEntryFingerprint(cfg.mcpServers.gbrain) }, null, 2));
}
const stdioKey = async (b: Box) => { const r = await gbrain(b, ['config', 'get', 'mcp.stdio_member']); return r.exitCode === 0 ? r.stdout.trim() : ''; };
function fakeOpenclaw(b: Box): string {
  const dir = join(b.root, 'oc-bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'openclaw'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'openclaw'), 0o755);
  return dir;
}
/** Every setup connection receipt under the box's HOME. */
function setupReceipts(b: Box): any[] {
  const found: any[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json')) { try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j?.connection === 'local-stdio' && j?.setup_receipt_version) found.push(j); } catch { /* not JSON */ } }
  } };
  walk(b.home);
  return found;
}
const claudeMd = (b: Box) => readFileSync(join(b.home, '.claude', 'CLAUDE.md'), 'utf8');
const normalized = (doc: any) => JSON.parse(JSON.stringify(doc).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T'));

describe('gbrain setup --serves (spawned, PGLite)', () => {
  test('--serves several labels each person, proves it with bound reads, prints key paths never values; a re-run keeps it all', async () => {
    const b = box();
    await brainWithPages(b);
    const preview = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--stdio-member', 'alice-example', '--dry-run']);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('stdio      this claude-code entry would start serve --stdio-member alice-example: only its sessions read as alice-example');
    expect(preview.stdout).toContain('serve --surface starter --advertise verbs --stdio-member alice-example');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    expect(await stdioKey(b)).toBe('');
    const first = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example']);
    expect(first.exitCode).toBe(0);
    for (const m of ROSTER) {
      const key = readFileSync(join(b.home, '.gbrain', 'member-keys', `${m}.key`), 'utf8').trim();
      expect(first.stdout + first.stderr).not.toContain(key);
      expect(first.stdout).toContain(`key        ${m}: ${join(b.home, '.gbrain', 'member-keys', `${m}.key`)} (minted, 0600; token member-${m})`);
      expect(first.stdout).toContain(`proof      a read bound to ${m} sees its own folder (1 page(s)) and no page of another member's folder`);
    }
    expect(first.stdout).toContain("stdio      this harness's stdio sessions read only pages no rule restricts");
    expect(entryArgs(b)).not.toContain('--stdio-member');
    expect(claudeMd(b)).not.toContain(SERVES_SEVERAL_LINE);
    expect(claudeMd(b)).toContain('apply your own access rules to what comes back');
    const again = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.serves.receipt.keys.map((k: any) => k.action)).toEqual(['keep', 'keep']);
    expect(again.doc.serves.proof).toEqual([
      { member: 'alice-example', own: 1, leaked: [] },
      { member: 'bob-example', own: 1, leaked: [] },
    ]);
    expect(again.doc.serves.brain_serves).toBe('one');
    expect((await gbrain(b, ['access', 'owner', 'set', 'alice-example'])).exitCode).toBe(0);
    const owner = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--json']);
    expect(owner.exitCode).toBe(0);
    expect(owner.doc.serves).toMatchObject({ brain_serves: 'one', stdio: { member: null, action: 'unbound' } });
    expect(owner.doc.serves.stdio.detail).toContain("this harness's stdio sessions read only pages no rule restricts");
    expect(owner.doc.serves.stdio.detail).toContain('gbrain setup claude-code --stdio-member <member>');
    expect(await stdioKey(b)).toBe('');
    const bound = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--stdio-member', 'alice-example', '--json']);
    expect(bound.exitCode).toBe(0);
    expect(bound.doc.serves).toMatchObject({ brain_serves: 'several', stdio: { member: 'alice-example', action: 'write' } });
    expect(bound.doc.serves.stdio.detail).toContain('this claude-code entry now starts serve --stdio-member alice-example: only its sessions read as alice-example, including pages only alice-example may read');
    expect(bound.doc.target.stdio_member).toBe('alice-example');
    expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    expect(await stdioKey(b)).toBe('');
    expect(claudeMd(b)).toContain(`- ${SERVES_SEVERAL_LINE}`);
    const carried = await setup(b, ['claude-code', '--json']);
    expect(carried.exitCode).toBe(0);
    expect(carried.doc.serves).toMatchObject({ mode: 'one', brain_serves: 'several', stdio: { member: 'alice-example', action: 'keep' } });
    expect(carried.doc.steps.find((s: any) => s.step === 'mcp')).toMatchObject({ action: 'keep' });
    expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    const receipts = setupReceipts(b);
    expect(receipts.length).toBeGreaterThan(0);
    for (const r of receipts) {
      expect(JSON.stringify(r)).not.toContain('stdio-member');
      expect(setupRerunArgv('claude-code', r)).not.toContain('--stdio-member');
    }
  }, 480_000);

  test('--stdio-member refuses an unknown member, off claude-code and codex, with --instructions-only or --no-stdio-member, and on a host with OpenClaw or Hermes; nothing is written', async () => {
    const b = box();
    await brainWithPages(b);
    for (const m of ROSTER) expect((await gbrain(b, ['access', 'member', 'add', m])).exitCode).toBe(0);
    expect((await gbrain(b, ['access', 'owner', 'set', 'alice-example'])).exitCode).toBe(0);
    const workspace = join(b.root, 'oc-workspace');
    mkdirSync(workspace);
    expect(existsSync(join(b.root, 'openclaw-state'))).toBe(false);
    const refusals: Array<[string[], string, Record<string, string>]> = [
      [['openclaw', '--serves', 'several', '--members', ROSTER.join(','), '--workspace', workspace, '--stdio-member', 'alice-example'], 'claude-code or codex', {}],
      [['claude-code', '--instructions-only', '--serves', 'several', '--stdio-member', 'alice-example'], 'claude-code or codex', {}],
      [['claude-code', '--stdio-member', 'alice-example', '--no-stdio-member'], 'not both', {}],
      [['claude-code', '--stdio-member', 'Alice Example'], 'needs a member id', {}],
      [['claude-code', '--stdio-member', 'alice-example'], 'OpenClaw is installed on this host', { PATH: `${fakeOpenclaw(b)}:${process.env.PATH}` }],
      [['codex', '--serves', 'several', '--members', ROSTER.join(','), '--stdio-member', 'alice-example'], 'Hermes is installed on this host', { HERMES_HOME: b.root }],
    ];
    for (const [args, says, env] of refusals) {
      const r = await gbrain(b, ['setup', ...args, '--gbrain-bin', b.bin], env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(says);
      if (says.endsWith('on this host')) expect(r.stderr).toContain('gbrain auth create <name> --member <id>');
      expect(await stdioKey(b)).toBe('');
      expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    }
    const unknown = await setup(b, ['claude-code', '--stdio-member', 'carol-example', '--json']);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stdout).toContain('not an enabled member of this brain');
    expect(unknown.stdout).toContain('alice-example, bob-example');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    const labelled = await setup(b, ['openclaw', '--serves', 'several', '--members', ROSTER.join(','), '--workspace', workspace]);
    expect(labelled.stdout + labelled.stderr).not.toContain('reads as alice-example');
    expect(await stdioKey(b)).toBe('');
  }, 360_000);

  test('codex keeps an entry member on a bare re-run and --no-stdio-member removes it on a several-person brain; a plugin-served harness and serve on a shared host refuse the flag', async () => {
    const b = box();
    await brainWithPages(b);
    for (const m of ROSTER) expect((await gbrain(b, ['access', 'member', 'add', m])).exitCode).toBe(0);
    const codexArgs = () => (Bun.TOML.parse(readFileSync(join(b.home, '.codex', 'config.toml'), 'utf8')) as any).mcp_servers.gbrain.args as string[];
    expect((await setup(b, ['codex', '--stdio-member', 'alice-example'])).exitCode).toBe(0);
    expect(codexArgs().slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    const rerun = await setup(b, ['codex', '--json']);
    expect(rerun.exitCode).toBe(0);
    expect(rerun.doc.serves.stdio).toMatchObject({ member: 'alice-example', action: 'keep' });
    expect(codexArgs().slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    const removed = await setup(b, ['codex', '--no-stdio-member', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.serves.stdio).toMatchObject({ member: null, action: 'remove' });
    expect(codexArgs()).not.toContain('--stdio-member');
    expect(await stdioKey(b)).toBe('');

    mkdirSync(join(b.home, '.claude'), { recursive: true });
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true } }));
    const plugin = await gbrain(b, ['setup', 'claude-code', '--stdio-member', 'alice-example', '--gbrain-bin', b.bin]);
    expect(plugin.exitCode).toBe(2);
    expect(plugin.stderr).toContain("plugin serves this claude-code gbrain MCP server");
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);

    const serveRefusals: Array<[string[], string, Record<string, string>]> = [
      [['--stdio-member', 'alice-example', '--http'], 'binds a stdio serve only', {}],
      [['--stdio-member', 'Alice Example'], 'needs a member id', {}],
      [['--stdio-member', 'alice-example', '--stdio-member=bob-example'], 'was given 2 times', {}],
      [['--stdio-member', 'alice-example'], 'OpenClaw is installed on this host', { PATH: `${fakeOpenclaw(b)}:${process.env.PATH}` }],
      [['--stdio-member', 'alice-example'], 'Hermes is installed on this host', { HERMES_HOME: b.root }],
    ];
    for (const [args, says, env] of serveRefusals) {
      const r = await gbrain(b, ['serve', ...args], env);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain(says);
    }
  }, 360_000);

  test('--stdio-member is checked against --members when this run labels them, and needs a brain otherwise; the engine no longer matters', () => {
    const outside = servesPreflight({ serves: 'several', members: 'alice-example,bob-example', stdioMember: 'carol-example', dryRun: false }, '/nonexistent/gbrain', 'claude-code', false, false);
    expect(outside).toMatchObject({ code: 'invalid_params' });
    expect((outside as Error).message).toContain('not one of the people in --members');
    const noBrain = servesPreflight({ stdioMember: 'alice-example', dryRun: false }, '/nonexistent/gbrain', 'codex', false, false);
    expect((noBrain as Error).message).toContain('this brain does not exist yet');
    expect(servesPreflight({ serves: 'several', members: 'alice-example,bob-example', stdioMember: 'alice-example', dryRun: true }, '/nonexistent/gbrain', 'claude-code', false, false)).toMatchObject({ roster: ROSTER, status: null });
  });

  test('upgrade paths carry an entry\'s --stdio-member forward and never add one: post-upgrade rewrites, setup re-runs from the receipt, --no-stdio-member removes it', async () => {
    const b = box();
    await brainWithPages(b);
    expect((await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--stdio-member', 'alice-example'])).exitCode).toBe(0);
    const refresh = async () => { const lines: string[] = []; await withEnv({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home }, () => refreshHookLaunchers((l) => lines.push(l))); return lines; };
    staleEntry(b);
    expect((await refresh()).join('\n')).toContain('now start gbrain from its own directory');
    expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    expect(entry(b).command).not.toBe(b.bin);
    for (const r of setupReceipts(b)) {
      const argv = setupRerunArgv('claude-code', r);
      expect(argv).not.toContain('--stdio-member');
      const rerun = await gbrain(b, [...argv.slice(1), '--json']);
      expect(rerun.exitCode).toBe(0);
      expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    }
    expect((await gbrain(b, ['apply-migrations', '--yes', '--no-autopilot-install'])).exitCode).toBe(0);
    expect(entryArgs(b).slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    const removed = await setup(b, ['claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--no-stdio-member', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.serves.stdio).toMatchObject({ member: null, action: 'remove' });
    expect(removed.doc.serves.stdio.detail).toContain('removed --stdio-member alice-example from this claude-code entry');
    expect(entryArgs(b)).not.toContain('--stdio-member');
    staleEntry(b);
    await refresh();
    expect(entryArgs(b)).not.toContain('--stdio-member');
    expect(entry(b).command).not.toBe(b.bin);
    expect(await stdioKey(b)).toBe('');
  }, 480_000);

  test('a brain setup cannot read refuses and writes nothing', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const broken = join(b.root, 'bin', 'gbrain-unreadable');
    writeFileSync(broken, `#!/bin/sh
if [ "$1" = access ] && [ "$2" = serves ]; then echo 'the brain is locked' >&2; exit 1; fi
exec '${process.execPath}' --no-env-file '${CLI}' "$@"
`);
    chmodSync(broken, 0o755);
    const r = await gbrain(b, ['setup', 'claude-code', '--json', '--gbrain-bin', broken]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('setup_serves_unreadable');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
  }, 240_000);

  test('--instructions-only --serves several keeps the one-person lines unless the brain serves several people with a bound stdio server', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const r = await setup(b, ['claude-code', '--instructions-only', '--serves', 'several']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('keep the one-person scoping lines');
    expect(claudeMd(b)).not.toContain(SERVES_SEVERAL_LINE);
  }, 240_000);

  test('an empty roster refuses with the fix and writes nothing', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--serves', 'several', '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('access_serves_roster_empty');
    expect(r.stdout + r.stderr).toContain('--members alice-example,bob-example');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    expect(existsSync(join(b.home, '.gbrain'))).toBe(false);
  }, 120_000);

  test('--serves one on a one-person brain is the default install: the same document, no serves key, the one-person block', async () => {
    const plain = box();
    const explicit = box();
    for (const b of [plain, explicit]) expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const a = await setup(plain, ['claude-code', '--json']);
    const c = await setup(explicit, ['claude-code', '--serves', 'one', '--json']);
    expect(a.exitCode).toBe(0);
    expect(c.exitCode).toBe(0);
    expect(a.doc.serves).toBeUndefined();
    expect(normalized(c.doc).serves).toBeUndefined();
    const strip = (doc: any, b: Box) => JSON.parse(JSON.stringify(normalized(doc)).replaceAll(b.root, '<root>'));
    expect(strip(c.doc, explicit)).toEqual(strip(a.doc, plain));
    expect(claudeMd(plain)).toContain(renderBrainFirstBlock('claude-code', { kind: 'mcp', server: 'gbrain', surface: 'verbs' }).split('\n').slice(1).join('\n'));
  }, 240_000);

  test('a plain setup on a brain that serves several people refuses and writes nothing; once an owner is named it binds this harness to the owner', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    for (const m of ROSTER) expect((await gbrain(b, ['access', 'member', 'add', m])).exitCode).toBe(0);
    const refused = await setup(b, ['claude-code', '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout).toContain('setup_serves_several');
    expect(refused.stdout).toContain('2 enabled members (alice-example, bob-example)');
    expect(refused.stdout).toContain('gbrain setup claude-code --serves several --members alice-example,bob-example');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    expect((await gbrain(b, ['access', 'owner', 'set', 'alice-example'])).exitCode).toBe(0);
    const owner = await setup(b, ['claude-code', '--json']);
    expect(owner.exitCode).not.toBe(0);
    expect(owner.stdout).toContain('setup_serves_several');
    expect(await stdioKey(b)).toBe('');
    expect((await gbrain(b, ['apply-migrations', '--yes', '--no-autopilot-install'])).exitCode).toBe(0);
    expect(await stdioKey(b)).toBe('');
    expect((await gbrain(b, ['config', 'set', 'mcp.stdio_member', 'alice-example'])).exitCode).toBe(0);
    const bound = await setup(b, ['claude-code', '--json']);
    expect(bound.exitCode).toBe(0);
    expect(bound.doc.serves).toMatchObject({ mode: 'one', brain_serves: 'several', stdio: { member: 'alice-example', action: 'keep' } });
    expect(claudeMd(b)).toContain(`- ${SERVES_SEVERAL_LINE}`);
  }, 300_000);

  test('a repo brain commits the folder rules to .gbrain/access.yml through the commit door, and the bound reads hold', async () => {
    const b = box();
    const repo = join(b.root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.co');
    git('config', 'user.name', 't');
    for (const [slug, canary] of Object.entries(PAGES)) { mkdirSync(join(repo, slug, '..'), { recursive: true }); writeFileSync(join(repo, `${slug}.md`), pageText(slug, canary)); }
    git('add', '-A');
    git('commit', '-qm', 'pages');
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gbrain(b, ['sources', 'add', 'team', '--path', repo])).exitCode).toBe(0);
    expect((await gbrain(b, ['sync', '--source', 'team', '--no-pull', '--no-embed'])).exitCode).toBe(0);
    const r = await gbrain(b, ['access', 'serves', 'several', '--members', ROSTER.join(','), '--source', 'team', '--yes', '--json']);
    expect(r.exitCode).toBe(0);
    const receipt = JSON.parse(r.stdout) as ServesReceipt;
    expect(receipt.rule_write).toMatchObject({ store: 'git', state: 'applied' });
    expect(git('log', '-1', '--format=%H')).toBe(receipt.rule_write!.git_commit!);
    expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, '.gbrain', 'access.yml'), 'utf8')).toContain('prefix: people/bob-example/');
    const seen = JSON.parse((await gbrain(b, ['find', 'people/', '--as', 'bob-example', '--source-id', 'team', '--json'])).stdout).pages.map((p: any) => p.slug);
    expect(seen).toEqual(['people/bob-example/plan', 'people/carol-public']);
  }, 240_000);
});

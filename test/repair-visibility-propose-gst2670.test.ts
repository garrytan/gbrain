/**
 * GST-2670 phase 2 (GBRA-502, decision B1): gbrain repair visibility --propose.
 *
 * 1. Protects: on a brain that serves several people, --propose reads the open pages' participants, attendees, to,
 *    from and cc addresses, matches each to an enabled member by declared email (exact, case-folded), groups pages by
 *    reader set with the owner first, writes one 0600 slugs file per set and prints the existing --readers command;
 *    a page with any unmatched address is listed, never guessed; DM, chat and mail pages with no list get the folder
 *    rule command. It labels nothing, refuses an --out inside a git work tree, and on a one-person brain (or one
 *    pinned to access.serves one) says "nothing to propose" before any pages query.
 * 2. Fails when: a guess or a disabled member's email makes a proposal, the owner is missing or not first, a slugs
 *    file holds other slugs or is readable by others, a write lands in pages, rules, config or members, a printed
 *    command does not parse with the real flag tables, or a one-person brain runs a pages query.
 * 3. Real seams: the gbrain repair CLI module (parse and dispatch), the access rule CLI module, PGLite repo-less
 *    (Postgres when DATABASE_URL is set); the printed command previewed and applied for real.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { parseRepairArgs, runRepairCommand } from '../src/commands/repair.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { proposalLines, type VisibilityProposal } from '../src/commands/repair-propose.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { CODES } from '../src/core/error-registry.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const SRC = 'source-a';
const fm = (type: string, extra = '') => `---\ntype: ${type}\ntitle: t\n${extra}---\n# t\n\nHarbor ledger body.\n`;
const PAGES: Array<[string, string]> = [
  ['meetings/m1', fm('meeting', 'attendees: [alice@example.com, BOB@Example.com]\n')],
  ['meetings/m5', fm('meeting', 'attendees: [bob@example.com, alice@example.com, owner@example.com]\n')],
  ['meetings/m4', fm('meeting', 'participants: [bob@example.com]\n')],
  ['emails/e1', fm('email', 'from: "Alice Example <alice@example.com>"\nto: [owner@example.com]\n')],
  ['emails/e2', fm('email', 'from: alice@example.com\ncc: [stranger@example.com]\n')],
  ['emails/e3', fm('email', 'participants: [carol@example.com]\n')],
  ['meetings/m2', fm('meeting', 'attendees: [alice-example]\n')],
  ['chats/team-a/day-1', fm('dm')],
  ['chats/team-a/day-2', fm('conversation')],
  ['notes/plain', fm('note')],
  ['labelled/m3', fm('meeting', 'attendees: [alice@example.com]\nreadable_by: [owner-example, alice-example]\n')],
];
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tempDir = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

/** Counts the queries that read the pages table. */
function spyPages(engine: BrainEngine): { count: () => number; restore: () => void } {
  const own = Object.prototype.hasOwnProperty.call(engine, 'executeRaw');
  const original = engine.executeRaw;
  let n = 0;
  (engine as any).executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) { if (/\bFROM pages\b/i.test(sql)) n++; return original.call(this, sql, params as never); };
  return { count: () => n, restore: () => { if (own) (engine as any).executeRaw = original; else delete (engine as any).executeRaw; } };
}

async function stateHash(engine: BrainEngine): Promise<string> {
  const rows = await Promise.all([
    engine.executeRaw("SELECT slug, source_id, frontmatter::text AS f, page_readers::text AS r FROM pages ORDER BY source_id, slug"),
    engine.executeRaw("SELECT source_id, rule_id FROM access_rules ORDER BY 1, 2"),
    engine.executeRaw("SELECT key, value FROM config WHERE key NOT LIKE 'doctor.%' ORDER BY key"),
    engine.executeRaw("SELECT id, email, labelled_only, disabled_at FROM access_members ORDER BY id"),
  ]);
  return JSON.stringify(rows);
}

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await fn(); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

for (const kind of testBackends()) {
  describe(`repair visibility --propose (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    const repair = (args: string[]) => withEnv({ GBRAIN_HOME: home }, () => capture(() => runRepairCommand(engine, args)));
    const propose = async (extra: string[] = []): Promise<VisibilityProposal> => JSON.parse(await repair(['visibility', '--propose', ...extra, '--json']));

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      home = tempDir('gbrain-propose-');
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING", [SRC]);
      for (const [slug, text] of PAGES) await importFromContent(engine, slug, text, { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, 'meetings/elsewhere', fm('meeting', 'attendees: [alice@example.com]\n'), { sourceId: 'default', noEmbed: true });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('a brain with no member, then one member, has nothing to propose and runs no pages query', async () => {
      for (const add of [null, 'owner-example']) {
        if (add) { await addMember(engine, add, { email: 'owner@example.com' }); await setOwner(engine, add); }
        const spy = spyPages(engine);
        try {
          const p = await propose();
          expect(p.applicable).toBe(false);
          expect(p.message).toStartWith('Nothing to propose');
          expect(proposalLines(p)).toEqual([p.message]);
          expect(p.sets).toEqual([]);
          expect(spy.count()).toBe(0);
        } finally { spy.restore(); }
      }
      expect(existsSync(join(home, '.gbrain', 'visibility-proposals'))).toBe(false);
    }, 60_000);

    test('a brain pinned to access.serves one with several enabled members has nothing to propose either', async () => {
      await addMember(engine, 'alice-example', { email: 'alice@example.com' });
      await addMember(engine, 'bob-example', { email: 'bob@example.com' });
      await addMember(engine, 'carol-example', { email: 'carol@example.com' });
      await engine.executeRaw("UPDATE access_members SET disabled_at = now() WHERE id = 'carol-example'");
      await engine.setConfig('access.serves', 'one');
      const spy = spyPages(engine);
      try {
        const p = await propose();
        expect(p.applicable).toBe(false);
        expect(p.message).toContain('access.serves is one');
        expect(spy.count()).toBe(0);
      } finally { spy.restore(); await engine.unsetConfig('access.serves'); }
    }, 60_000);

    test('it groups fully matched pages by reader set, owner first, lists unmatched and chat folders, and writes nothing but 0600 slugs files', async () => {
      const before = await stateHash(engine);
      const p = await propose(['--source', SRC]);
      expect(await stateHash(engine)).toBe(before);
      expect(p.applicable).toBe(true);
      expect(p.owner).toBe('owner-example');
      const sets = Object.fromEntries(p.sets.map(s => [s.readers.join(','), readFileSync(s.file, 'utf8')]));
      expect(sets).toEqual({
        'owner-example,alice-example,bob-example': 'meetings/m1\nmeetings/m5\n',
        'owner-example,alice-example': 'emails/e1\n',
        'owner-example,bob-example': 'meetings/m4\n',
      });
      for (const s of p.sets) {
        expect(s.readers[0]).toBe('owner-example');
        expect(s.source).toBe(SRC);
        expect(statSync(s.file).mode & 0o777).toBe(0o600);
        expect(s.file.startsWith(join(home, '.gbrain', 'visibility-proposals') + '/')).toBe(true);
        expect(s.command).toBe(`gbrain repair visibility --source ${SRC} --slugs-file ${s.file} --readers ${s.readers.join(',')}`);
      }
      expect(readdirSync(join(home, '.gbrain', 'visibility-proposals')).sort()).toEqual(p.sets.map(s => basename(s.file)).sort());
      expect(Object.fromEntries(p.unmatched.map(u => [u.slug, u.addresses]))).toEqual({
        'emails/e2': ['stranger@example.com'], 'emails/e3': ['carol@example.com'], 'meetings/m2': ['alice-example'] });
      expect(p.folders).toEqual([{ source: SRC, folder: 'chats/team-a/', pages: 2,
        command: `gbrain access rule add --prefix chats/team-a/ --readers owner-example,<list> --source ${SRC}` }]);
      expect(JSON.stringify(p)).not.toContain('notes/plain');
      const all = [...p.sets.flatMap(s => readFileSync(s.file, 'utf8').trim().split('\n')), ...p.unmatched.map(u => u.slug)];
      expect(all).not.toContain('labelled/m3');
      expect(all).not.toContain('meetings/elsewhere');
      const text = await repair(['visibility', '--propose', '--source', SRC]);
      expect(text).toContain('derived atoms, facts and chronicle events');
      expect(text).toContain('access.members_read_lineage');
      expect(text).toContain('emails/e2 (stranger@example.com)');
      expect(await stateHash(engine)).toBe(before);
    }, 60_000);

    test('without --source it reads every source, still only open pages', async () => {
      const p = await propose();
      const elsewhere = p.sets.find(s => s.source === 'default');
      expect(elsewhere?.readers).toEqual(['owner-example', 'alice-example']);
      expect(readFileSync(elsewhere!.file, 'utf8')).toBe('meetings/elsewhere\n');
    }, 60_000);

    test('an --out inside a git work tree is refused before anything is written', async () => {
      const repo = tempDir('gbrain-propose-git-');
      execFileSync('git', ['init', '-q', repo]);
      const out = join(repo, 'nested', 'proposals');
      const before = await stateHash(engine);
      let error: any;
      try { await propose(['--out', out]); } catch (e) { error = e; }
      expect(error?.code).toBe('repair_propose_dir_in_git');
      expect(CODES.repair_propose_dir_in_git).toBeDefined();
      expect(existsSync(join(repo, 'nested'))).toBe(false);
      expect(await stateHash(engine)).toBe(before);
      const outside = join(tempDir('gbrain-propose-out-'), 'sets');
      const p = await propose(['--source', SRC, '--out', outside]);
      expect(p.dir).toBe(outside);
      for (const s of p.sets) expect(s.file.startsWith(outside + '/')).toBe(true);
    }, 60_000);

    test('--propose takes only --source, --out and --json, and --out needs --propose', () => {
      for (const extra of [['--apply'], ['--expect', 'h'], ['--readers', 'alice-example'], ['--slug', 'notes/a'], ['--limit', '5']]) {
        expect(() => parseRepairArgs(['visibility', '--propose', ...extra])).toThrow(/does not apply with --propose/);
      }
      expect(() => parseRepairArgs(['visibility', '--out', '/srv/x'])).toThrow(/--out applies only with --propose/);
      expect(() => parseRepairArgs(['frontmatter', '--propose'])).toThrow(/--propose applies only to gbrain repair visibility/);
      expect(CLI_FLAG_REGISTRY.repair).toEqual(expect.arrayContaining(['--propose', '--out']));
    });

    test('each printed command parses with the real flag tables, previews, and applying one closes exactly its pages', async () => {
      const p = await propose(['--source', SRC]);
      for (const s of p.sets) {
        const argv = s.command.split(' ');
        expect(argv.slice(0, 3)).toEqual(['gbrain', 'repair', 'visibility']);
        const parsed = parseRepairArgs(argv.slice(2));
        expect(parsed).toMatchObject({ kind: 'visibility', source: SRC, slugsFile: s.file, readers: s.readers.join(','), apply: false, propose: false });
        for (const flag of argv.filter(a => a.startsWith('--'))) expect(CLI_FLAG_REGISTRY.repair).toContain(flag);
      }
      for (const f of p.folders) {
        const argv = f.command.replace('<list>', 'alice-example').split(' ');
        expect(argv.slice(0, 4)).toEqual(['gbrain', 'access', 'rule', 'add']);
        for (const flag of argv.filter(a => a.startsWith('--'))) expect(CLI_FLAG_REGISTRY.access).toContain(flag);
        const before = await stateHash(engine);
        const preview = JSON.parse(await capture(() => runAccessRules(engine, 'rule', [...argv.slice(3), '--json'], true)));
        expect(preview.applied).toBe(false);
        expect(await stateHash(engine)).toBe(before);
      }
      const set = p.sets.find(s => s.readers.length === 3)!;
      const preview = JSON.parse(await repair([...set.command.split(' ').slice(2), '--json'])).results[0];
      expect(preview.affected).toBe(2);
      await repair([...set.command.split(' ').slice(2), '--apply', '--expect', preview.preview_hash, '--json']);
      const rows = await engine.executeRaw<{ slug: string; r: unknown }>("SELECT slug, frontmatter->'readable_by' AS r FROM pages WHERE source_id = $1 AND slug IN ('meetings/m1', 'meetings/m5') ORDER BY slug", [SRC]);
      for (const row of rows) expect(row.r).toEqual(['owner-example', 'alice-example', 'bob-example']);
      const again = await propose(['--source', SRC]);
      expect(again.sets.map(s => s.readers.join(',')).sort()).toEqual(['owner-example,alice-example', 'owner-example,bob-example']);
    }, 120_000);
  });
}

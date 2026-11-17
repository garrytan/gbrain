/**
 * GST-2904 (GBRA-592, decision M and P, PR 2): gbrain repair visibility --propose covers imported calls.
 *
 * 1. Protects: calls written by the importer before calls were kept to their attendees (no readable_by, attendees only in
 *    the call header) get a proposal of the owner plus the matched attendees, owner first, even when some names match
 *    nobody; those names are listed beside the proposal, never guessed. A call with no list proposes the owner only.
 *    Apply stays preview-bound (--expect), a page that moved refuses preview_changed, and a non-call page with an
 *    unmatched address still gets no proposal. Nothing changes until the admin applies.
 * 2. Fails when: a call page is skipped, a partial match drops the call, a name is guessed, the owner is missing or not
 *    first, or a non-call page loses today's all-or-nothing rule.
 * 3. Real seams: runCallImport with --readers source (pages byte-identical to the importer before PR 1), the gbrain repair
 *    CLI module, PGLite repo-less (Postgres through test/e2e). Placeholder names only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { runCallImport } from '../src/commands/import-calls.ts';
import type { VisibilityProposal } from '../src/commands/repair-propose.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const SRC = 'company';
const OWNER = 'owner-example';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tempDir = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); roots.push(d); return d; };
const CALLS: Record<string, string> = {
  '2026-11-12 hiring debrief.md': '# Hiring debrief\nDate: 2026-11-12\nAttendees: owner, carol-example\n\ncarol-example: the band is 210k.\n',
  '2026-11-11 pricing review.txt': 'Pricing review\nAttendees: Alice Example, bob-example\n\nbob-example: annual billing.\n',
  '2026-11-10 weekly eng sync.md': 'Weekly eng sync\nAttendees: bob-example, carol-example\n\nbob-example: deploy Tuesday.\n',
  '2026-11-09 acme renewal.md': 'Acme renewal\nAttendees: alice-example, dave-example (acme-example procurement)\n\nalice-example: renew.\n',
  '2026-11-08 standup.txt': 'Standup\nalice-example: shipping today.\n',
};
const argv = (command: string): string[] => execFileSync('bash', ['-c', `printf '%s\\0' ${command}`], { encoding: 'utf8' }).split('\0').slice(0, -1);

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await fn(); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

for (const kind of testBackends()) {
  describe(`repair visibility --propose covers imported calls (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    const repair = (args: string[]) => withEnv({ GBRAIN_HOME: home }, () => capture(() => runRepairCommand(engine, args)));
    const propose = async (): Promise<VisibilityProposal> => JSON.parse(await repair(['visibility', '--propose', '--source', SRC, '--json']));

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      home = tempDir('gbrain-propose-calls-');
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await addMember(engine, OWNER, { email: 'owner@acme-example.test' });
      await addMember(engine, 'alice-example', { name: 'Alice Example', email: 'alice@acme-example.test' });
      await addMember(engine, 'bob-example', { email: 'bob@acme-example.test' });
      await addMember(engine, 'carol-example', { email: 'carol@acme-example.test' });
      await setOwner(engine, OWNER);
      const dir = tempDir('gbrain-propose-calls-src-');
      for (const [name, text] of Object.entries(CALLS)) writeFileSync(join(dir, name), text);
      _resetCliExitVerdictForTests();
      await capture(() => runCallImport(engine, dir, ['--calls', '--prefix', 'company/calls', '--readers', 'source'], { sourceId: SRC, json: false, unboundStdio: () => [] }));
      const [open] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND starts_with(slug, 'company/calls/') AND NOT (frontmatter ? 'readable_by')", [SRC]);
      if (Number(open!.n) !== 5) throw new Error('fixture: five open call pages expected');
      await importFromContent(engine, 'meetings/m1', '---\ntype: meeting\ntitle: t\nattendees: [alice@acme-example.test, stranger@other-example.test]\n---\n# t\n\nbody\n', { sourceId: SRC, noEmbed: true });
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('each open call gets the owner plus its matched attendees, owner first; unmatched names are listed beside it', async () => {
      const p = await propose();
      const sets = Object.fromEntries(p.sets.map(s => [s.readers.join(','), readFileSync(s.file, 'utf8').trim().split('\n').sort()]));
      expect(sets).toEqual({
        'owner-example,carol-example': ['company/calls/2026-11-12-hiring-debrief'],
        'owner-example,alice-example,bob-example': ['company/calls/2026-11-11-pricing-review'],
        'owner-example,bob-example,carol-example': ['company/calls/2026-11-10-weekly-eng-sync'],
        'owner-example,alice-example': ['company/calls/2026-11-09-acme-renewal'],
        'owner-example': ['company/calls/2026-11-08-standup'],
      });
      const unmatched = Object.fromEntries(p.unmatched.map(u => [u.slug, { addresses: u.addresses, call: (u.reason ?? '').startsWith('an imported call: proposed') }]));
      expect(unmatched).toEqual({
        'company/calls/2026-11-09-acme-renewal': { addresses: ['dave-example (acme-example procurement)'], call: true },
        'meetings/m1': { addresses: ['stranger@other-example.test'], call: false },
      });
      const [labelled] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND frontmatter ? 'readable_by'", [SRC]);
      expect(Number(labelled!.n)).toBe(0);
    }, 120_000);

    test('apply is preview-bound: --expect writes the readers, and a page that moved refuses preview_changed', async () => {
      const p = await propose();
      const debrief = p.sets.find(s => s.readers.join(',') === 'owner-example,carol-example')!;
      const preview = JSON.parse(await repair([...argv(debrief.command).slice(2), '--json'])).results[0];
      await repair([...argv(debrief.command).slice(2), '--apply', '--expect', preview.preview_hash, '--json']);
      const [row] = await engine.executeRaw<{ r: unknown }>("SELECT frontmatter->'readable_by' AS r FROM pages WHERE source_id = $1 AND slug = 'company/calls/2026-11-12-hiring-debrief'", [SRC]);
      expect(row!.r).toEqual([OWNER, 'carol-example']);
      const renewal = p.sets.find(s => s.readers.join(',') === 'owner-example,alice-example')!;
      const stale = JSON.parse(await repair([...argv(renewal.command).slice(2), '--json'])).results[0];
      await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"readable_by\": [\"owner-example\", \"bob-example\"]}'::jsonb WHERE source_id = $1 AND slug = 'company/calls/2026-11-09-acme-renewal'", [SRC]);
      const refused = await repair([...argv(renewal.command).slice(2), '--apply', '--expect', stale.preview_hash, '--json']).then(t => t, e => JSON.stringify({ code: (e as { code?: string }).code }));
      expect(refused).toContain('preview_changed');
    }, 120_000);

    test('the owner reads a call before and after its proposal is applied; a teammate who was not on it stops reading it', async () => {
      const slug = 'company/calls/2026-11-11-pricing-review';
      const text = async (ctx: Record<string, unknown>) => (await dispatchToolCall(engine, 'get_page', { slug }, { sourceId: SRC, ...ctx } as never)).content.map(c => c.text).join('\n');
      const view = async () => ({ owner_stdio: (await text({ remote: true, transport: 'stdio', stdioMember: OWNER })).includes('annual billing'),
        owner_local: (await text({ remote: false })).includes('annual billing'),
        bob: (await text({ remote: true, transport: 'stdio', stdioMember: 'bob-example' })).includes('annual billing'),
        carol: (await text({ remote: true, transport: 'stdio', stdioMember: 'carol-example' })).includes('annual billing') });
      expect(await view()).toEqual({ owner_stdio: true, owner_local: true, bob: true, carol: true });
      const set = (await propose()).sets.find(s => s.readers.join(',') === 'owner-example,alice-example,bob-example')!;
      const preview = JSON.parse(await repair([...argv(set.command).slice(2), '--json'])).results[0];
      await repair([...argv(set.command).slice(2), '--apply', '--expect', preview.preview_hash, '--json']);
      expect(await view()).toEqual({ owner_stdio: true, owner_local: true, bob: true, carol: false });
    }, 120_000);
  });
}

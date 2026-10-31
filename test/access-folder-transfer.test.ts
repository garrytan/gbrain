/**
 * GBRA-218 (A2) folder rules across gbrain export and import, on repo-less
 * PGLite brains: an export carries the applied rulebook (never a held
 * widening), import installs it before publishing any page and keeps that
 * barrier across a failure and a rerun, several sources travel as
 * source-qualified files that import maps explicitly, and a source whose
 * committed file is invalid refuses to export.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExport } from '../src/commands/export.ts';
import { runImport } from '../src/commands/import.ts';
import { parsePolicyYaml } from '../src/core/access/folder-rules.ts';
import { appliedRules, clearPolicyInvalid, coverageRows, markPolicyInvalid, policySeams, proposeRevision } from '../src/core/access/policy.ts';
import { exportPolicyFiles } from '../src/core/access/policy-transfer.ts';

const page = (title: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Body.'].join('\n');
const rule = (id: string, prefix: string, readers: string[]) => ({ id, prefix, readable_by: readers });
const ALICE = rule('alice', 'partners/alice-example/', ['member:alice-example']);

async function seedSources(e: BrainEngine, sources: string[]): Promise<BrainEngine> {
  for (const s of sources) await e.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [s]);
  return e;
}
const stamps = async (e: BrainEngine, source: string) => Object.fromEntries((await e.executeRaw<{ slug: string; folder_rule_ids: string[] | null }>(
  'SELECT slug, folder_rule_ids FROM pages WHERE source_id = $1 ORDER BY slug', [source])).map(r => [r.slug, r.folder_rule_ids]));
const silenced = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [log, err] = [console.log, console.error];
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

describe('folder rules across export and import (pglite, repo-less)', () => {
  let from: BrainEngine; let to: BrainEngine;
  const dirs: string[] = [];
  const fresh = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-access-x-'))); dirs.push(d); return d; };

  beforeAll(async () => {
    from = new PGLiteEngine(); await from.connect({ engine: 'pglite' } as never); await from.initSchema();
    to = new PGLiteEngine(); await to.connect({ engine: 'pglite' } as never); await to.initSchema();
    await seedSources(from, ['src-a', 'src-b', 'src-c']);
    await seedSources(to, ['dst', 'dst2']);
    await importFromContent(from, 'partners/alice-example/plan', page('Plan'), { sourceId: 'src-a', noEmbed: true });
    await importFromContent(from, 'notes/open', page('Open'), { sourceId: 'src-a', noEmbed: true });
    await importFromContent(from, 'partners/bob-example/deal', page('Deal'), { sourceId: 'src-b', noEmbed: true });
    await proposeRevision(from, 'src-a', [ALICE], { origin: 'cli', store: 'database' });
    await proposeRevision(from, 'src-a', [], { origin: 'cli' });
    await proposeRevision(from, 'src-b', [rule('partners', 'partners/', ['member:bob-example'])], { origin: 'cli', store: 'database' });
    await proposeRevision(from, 'src-c', [rule('partners', 'partners/', ['member:carol-example'])], { origin: 'cli', store: 'database' });
  }, 120_000);
  afterAll(async () => {
    policySeams.afterInstall = undefined;
    await from.disconnect(); await to.disconnect();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('a one-source export carries the applied rulebook, not the held widening', async () => {
    const dir = fresh();
    await silenced(() => runExport(from, ['--dir', dir, '--source', 'src-a']));
    for (const f of ['.gbrain/access.yml', '.gbrain/access.approved']) {
      const parsed = parsePolicyYaml(readFileSync(join(dir, f), 'utf8'));
      expect(parsed.ok && parsed.rules).toEqual([ALICE]);
    }
    expect(existsSync(join(dir, 'partners/alice-example/plan.md'))).toBe(true);
  }, 60_000);

  test('import installs the rules before any page, across a failure and a rerun', async () => {
    const dir = fresh();
    await silenced(() => runExport(from, ['--dir', dir, '--source', 'src-a']));
    await importFromContent(to, 'partners/alice-example/old', page('Old'), { sourceId: 'dst', noEmbed: true });
    let seen = null as number | null;
    policySeams.afterInstall = async () => {
      seen = (await to.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = 'dst' AND slug = 'partners/alice-example/plan'"))[0]!.n;
      throw new Error('interrupted');
    };
    try { await expect(silenced(() => runImport(to, [dir, '--source', 'dst', '--no-embed']))).rejects.toThrow('folder rules not installed'); }
    finally { policySeams.afterInstall = undefined; }
    expect(seen).toBe(0);
    expect(Object.keys(await stamps(to, 'dst'))).toEqual(['partners/alice-example/old']);
    expect((await coverageRows(to, 'dst')).map(c => [c.prefix, c.reason])).toEqual([['partners/alice-example/', 'pending']]);
    expect(await appliedRules(to, 'dst')).toEqual([ALICE]);

    await silenced(() => runImport(to, [dir, '--source', 'dst', '--no-embed']));
    expect(await stamps(to, 'dst')).toEqual({ 'notes/open': null, 'partners/alice-example/old': ['dst:alice'], 'partners/alice-example/plan': ['dst:alice'] });
    expect(await coverageRows(to, 'dst')).toEqual([]);
  }, 60_000);

  test('several sources travel as source-qualified files, including one with no page, and import maps them explicitly', async () => {
    const dir = fresh();
    await silenced(() => runExport(from, ['--dir', dir]));
    expect(existsSync(join(dir, '.gbrain/access.yml'))).toBe(false);
    const qualified = (s: string) => { const p = parsePolicyYaml(readFileSync(join(dir, '.gbrain/access', s + '.yml'), 'utf8')); return p.ok ? p.rules : p.problems; };
    expect(qualified('src-a')).toEqual([ALICE]);
    expect(qualified('src-b')).toEqual([rule('partners', 'partners/', ['member:bob-example'])]);
    expect(qualified('src-c')).toEqual([rule('partners', 'partners/', ['member:carol-example'])]);

    await expect(silenced(() => runImport(to, [dir, '--source', 'dst2', '--no-embed']))).rejects.toThrow('folder rules not installed');
    expect(await stamps(to, 'dst2')).toEqual({});
    expect(await appliedRules(to, 'dst2')).toEqual([]);

    await silenced(() => runImport(to, [dir, '--source', 'dst2', '--no-embed', '--access-policy', 'src-b']));
    expect(await appliedRules(to, 'dst2')).toEqual([rule('partners', 'partners/', ['member:bob-example'])]);
    const s = await stamps(to, 'dst2');
    expect(s['partners/bob-example/deal']).toEqual(['dst2:partners']);
    expect(s['partners/alice-example/plan']).toEqual(['dst2:partners']);
    expect(s['notes/open']).toBeNull();
  }, 60_000);

  test('an imported rulebook that widens what the destination has is held', async () => {
    const dir = fresh();
    await silenced(() => runExport(from, ['--dir', dir, '--source', 'src-b']));
    await silenced(() => runImport(to, [dir, '--source', 'dst', '--no-embed']));
    expect(await appliedRules(to, 'dst')).toEqual([ALICE, rule('partners', 'partners/', ['member:bob-example'])].sort((x, y) => x.id.localeCompare(y.id)));
  }, 60_000);

  test('a source whose committed file is invalid refuses to export its rules', async () => {
    await markPolicyInvalid(from as never, 'src-c', ['hr/'], { problems: [{ line: 3, message: 'bad' }] });
    await expect(exportPolicyFiles(from, 'src-c')).rejects.toMatchObject({ code: 'access_policy_invalid' });
    await expect(exportPolicyFiles(from, null)).rejects.toMatchObject({ code: 'access_policy_invalid' });
    await clearPolicyInvalid(from, 'src-c');
    expect((await exportPolicyFiles(from, null)).map(f => f.path)).toEqual(['.gbrain/access/src-a.yml', '.gbrain/access/src-b.yml', '.gbrain/access/src-c.yml']);
  }, 60_000);
});

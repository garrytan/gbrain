/**
 * #6712 PR 4b (GBRA-130 A-20, not reproducible): frontmatter validation does not depend on the active schema pack. The pack
 * reaches `parseMarkdown` only through type and subtype inference, and the screen only through the fence context
 * (`takes_kinds`), so a pack switch cannot turn bytes a validating gbrain imported into an `invalid_frontmatter` refusal
 * and stop the source as `sync_parser_regression` (sync-screen.ts provenance branch). If this guard ever fails, A-20 is
 * real: the provenance check would read a pack change as a parser regression.
 *
 * Protects:
 * - for the same bytes, the screen's verdict (status, and for a refusal its code, reason and line) is identical under
 *   pack A, pack B and no pack, for refused and for importable bytes;
 * - end to end: a source imported under pack A (validated provenance) whose active pack switches to pack B, with nothing
 *   changed in Git, syncs on a full run with no hold and no stop.
 *
 * PGLite here; Postgres through test/e2e/sync-pack-independent-frontmatter-6712-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { screenImportContent } from '../src/core/import-screen.ts';
import { readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { loadActivePackForEngine } from '../src/core/schema-pack/engine-resolution.ts';
import { VERSION } from '../src/version.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
/** Two packs that disagree on page types and takes kinds; `people/` is typed only under pack A. */
const PACKS = { a: { name: 'pack-a', types: ['person'], kinds: ['fact', 'bet'] }, b: { name: 'pack-b', types: ['widget'], kinds: ['fact'] } } as const;
const manifest = (pack: typeof PACKS[keyof typeof PACKS]) => ({ page_types: pack.types.map(name => ({ name, path_prefixes: [`${name === 'person' ? 'people' : `${name}s`}/`] })), takes_kinds: [...pack.kinds] });
const packYaml = (pack: typeof PACKS[keyof typeof PACKS]) => ['api_version: gbrain-schema-pack-v1', `name: ${pack.name}`, 'version: 1.0.0', 'description: ""', 'gbrain_min_version: 0.38.0', 'extends: null', 'borrow_from: []',
  'page_types:', ...manifest(pack).page_types.flatMap(t => [`  - name: ${t.name}`, '    primitive: entity', `    path_prefixes: ["${t.path_prefixes[0]}"]`, '    aliases: []']),
  'link_types: []', 'frontmatter_links: []', `takes_kinds: [${pack.kinds.join(', ')}]`, 'enrichable_types: []', 'filing_rules: []', ''].join('\n');

const BYTES: Record<string, string> = {
  importable: '---\ntitle: Alice Example\n---\n# Alice Example\n\nA person.\n',
  folded_continuation: '---\ntitle: first line\nsecond line\n---\nA synthetic post.\n',
  mis_indented: '---\ntitle: Alice Example\ntags:\n  - one\n - two\n---\nBody.\n',
  duplicate_identity_key: '---\ntitle: Alice Example\ntype: person\ntype: concept\n---\nBody.\n',
};

test('the screen\'s frontmatter verdict for the same bytes is identical under pack A, pack B and no pack', () => {
  const verdicts = Object.fromEntries(Object.entries(BYTES).map(([label, content]) => {
    const screen = (activePack?: ReturnType<typeof manifest>) => {
      const result = screenImportContent({ content, path: 'people/alice-example.md', ...(activePack ? { activePack } : {}) });
      return result.status === 'refused' ? { status: result.status, code: result.refusal.code, reason: result.refusal.reason ?? null, line: result.refusal.line ?? null } : { status: result.status };
    };
    const none = screen();
    expect({ label, a: screen(manifest(PACKS.a)), b: screen(manifest(PACKS.b)) }).toEqual({ label, a: none, b: none });
    return [label, none];
  }));
  expect(Object.values(verdicts).filter(v => v.status === 'refused' && 'code' in v && v.code === 'invalid_frontmatter')).toHaveLength(3);
  expect(verdicts.importable).toEqual({ status: 'importable' });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#6712 PR 4b frontmatter validation is pack-independent (${backend})`, () => {
    test('imported under pack A with validated provenance, switched to pack B, nothing changed in Git: a full sync syncs with no hold and no stop', () => managedBrain(async ({ engine }) => {
      const home = process.env.GBRAIN_HOME!;
      for (const pack of Object.values(PACKS)) { mkdirSync(join(home, '.gbrain', 'schema-packs', pack.name), { recursive: true }); writeFileSync(join(home, '.gbrain', 'schema-packs', pack.name, 'pack.yaml'), packYaml(pack)); }
      await engine.setConfig('schema_pack.source.default', PACKS.a.name);
      expect((await loadActivePackForEngine(engine, { remote: false, sourceId: 'default' })).manifest.name).toBe(PACKS.a.name);
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      expect(await engine.executeRaw("SELECT completed_keys->0->>'validated' AS validated, completed_keys->0->>'gbrain_version' AS version FROM op_checkpoints WHERE op=$1", [SYNC_IMPORT_PROVENANCE_OP]))
        .toEqual([{ validated: 'true', version: VERSION }, { validated: 'true', version: VERSION }]);
      await engine.setConfig('schema_pack.source.default', PACKS.b.name);
      expect((await loadActivePackForEngine(engine, { remote: false, sourceId: 'default' })).manifest.name).toBe(PACKS.b.name);
      const switched = await performManagedSync(engine, { ...OPTS, full: true });
      expect(switched.status).toBe('synced');
      expect(switched.held ?? []).toEqual([]);
      expect((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).toEqual([]);
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup: ({ root }) => {
      mkdirSync(join(root, 'people'), { recursive: true }); git(root, 'init', '-q');
      writeFileSync(join(root, 'people/alice-example.md'), BYTES.importable!);
      writeFileSync(join(root, 'notes.md'), '---\ntitle: Notes\ntype: note\n---\n# Notes\n\nPlain.\n');
      git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    } }), 120_000);
  });
}

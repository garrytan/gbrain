/**
 * GST-2638: the first `gbrain access rule import` on a source with a git checkout and no policy revision yet.
 *
 * 1. Protects: a shallow checkout refuses the import up front (preview and --yes) with the fix and writes nothing, so the
 *    source stays readable; a first import on a source with no policy history never marks the whole source invalid; an
 *    import whose result is invalid exits non-zero; a commit a pre-commit hook refuses leaves the store unset;
 *    `access rule migrate --to database` sets the database store from unset with no commit and no file; the preview
 *    says when the owner's remote callers (owner reads restricted) lose the narrowed pages while it is pending.
 * 2. Fails when: any of those regresses to the v0.60.688.0 behaviour (a whole-source mark that a shallow checkout never
 *    clears, exit 0 on state invalid, a stranded git store, no commit-free route to the database store, a silent preview).
 * 3. Existing coverage: access-folder-rules-git (the git store and rebuilds), access-folder-rules (the database store).
 * 4. Real seams: real git repositories and hooks, gbrain git commit-push through the CLI module, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { coverageRows, policySeams, readAccessStore } from '../src/core/access/policy.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { OWNER_MEMBER_KEY, OWNER_READS_RESTRICTED_KEY } from '../src/core/search/private-visibility.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const POLICY = 'version: 1\nrules:\n  - id: alice\n    prefix: partners/alice-example/\n    readable_by: [alice-example]\n';

for (const kind of testBackends()) {
  describe(`first access-policy import (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const dirs: string[] = [];
    let n = 0;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const e = new PGLiteEngine(); await e.connect({ engine: 'pglite' } as never); await e.initSchema(); engine = e; close = () => e.disconnect(); }
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', ['alice-example']);
    }, 240_000);

    afterAll(async () => {
      policySeams.afterInstall = undefined;
      _resetCliExitVerdictForTests();
      process.exitCode = 0;
      await close();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });

    const tmp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `gbrain-gst2638-${tag}-`)); dirs.push(d); return d; };

    function repo(): string {
      const root = tmp('repo');
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 't@t.co');
      git(root, 'config', 'user.name', 't');
      mkdirSync(join(root, 'partners/alice-example'), { recursive: true });
      writeFileSync(join(root, 'partners/alice-example/plan.md'), '# plan\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'pages');
      writeFileSync(join(root, 'notes.md'), '# notes\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'more pages');
      return root;
    }

    async function source(root: string | null): Promise<string> {
      const id = `src-${kind}-${++n}`;
      await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}')", [id, root]);
      return id;
    }

    function policyFile(text = POLICY): string {
      const f = join(tmp('file'), 'access.yml');
      writeFileSync(f, text);
      return f;
    }

    async function cli(args: string[]): Promise<any> {
      const lines: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
      try { await runAccessRules(engine, args[0]!, [...args.slice(1), '--json'], true); } finally { spy.mockRestore(); }
      return JSON.parse(lines.join('\n'));
    }

    const invalid = async (id: string) => (await coverageRows(engine, id)).filter(c => c.reason === 'invalid').map(c => c.prefix);

    test('a shallow checkout refuses the import up front, in the preview and with --yes; nothing is written and the source stays readable', async () => {
      const shallow = tmp('shallow');
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo()}`, shallow], { stdio: 'ignore' });
      const id = await source(shallow);
      const head = git(shallow, 'rev-parse', 'HEAD');
      const file = policyFile();
      for (const extra of [[], ['--yes']]) {
        await expect(cli(['rule', 'import', '--file', file, '--source', id, ...extra])).rejects.toMatchObject({ code: 'access_policy_history_unreadable' });
      }
      await expect(cli(['rule', 'import', '--file', file, '--source', id])).rejects.toMatchObject({ suggestion: expect.stringContaining('fetch --unshallow'), fix: { argv: ['git', '-C', shallow, 'fetch', '--unshallow'] } });
      expect({ invalid: await invalid(id), store: await readAccessStore(engine, id), head: git(shallow, 'rev-parse', 'HEAD'), file: existsSync(join(shallow, '.gbrain/access.yml')) })
        .toEqual({ invalid: [], store: null, head, file: false });
    }, 120_000);

    test('a first import on a source with no policy history never marks the whole source invalid', async () => {
      const root = repo();
      const id = await source(root);
      const seen: string[][] = [];
      policySeams.afterInstall = async () => { seen.push(await invalid(id)); };
      try {
        const r = await cli(['rule', 'import', '--file', policyFile(), '--source', id, '--yes']);
        expect({ state: r.state, store: r.store }).toEqual({ state: 'applied', store: 'git' });
      } finally { policySeams.afterInstall = undefined; }
      expect({ seen, invalid: await invalid(id), store: await readAccessStore(engine, id) }).toEqual({ seen: [[]], invalid: [], store: 'git' });
    }, 120_000);

    test('an import whose result state is invalid exits non-zero', async () => {
      const root = repo();
      const hook = join(root, '.git/hooks/post-commit');
      writeFileSync(hook, '#!/bin/sh\n[ -f .git/gst2638-done ] && exit 0\ntouch .git/gst2638-done\nprintf "version: 1\\nrules: [broken\\n" > .gbrain/access.yml\ngit add .gbrain/access.yml\ngit commit -q --no-verify -m "a later commit breaks the file"\n');
      chmodSync(hook, 0o755);
      const id = await source(root);
      _resetCliExitVerdictForTests();
      try {
        const r = await cli(['rule', 'import', '--file', policyFile(), '--source', id, '--yes']);
        expect({ state: r.state, exit: currentExitCode() }).toEqual({ state: 'invalid', exit: 1 });
      } finally { _resetCliExitVerdictForTests(); process.exitCode = 0; }
    }, 120_000);

    test('a commit a pre-commit hook refuses leaves the store unset and the source readable', async () => {
      const root = repo();
      const hook = join(root, '.git/hooks/pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho refused by policy >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      const id = await source(root);
      await expect(cli(['rule', 'import', '--file', policyFile(), '--source', id, '--yes'])).rejects.toThrow();
      expect({ store: await readAccessStore(engine, id), invalid: await invalid(id), file: existsSync(join(root, '.gbrain/access.yml')) }).toEqual({ store: null, invalid: [], file: false });
    }, 120_000);

    test('access rule migrate --to database sets the database store from unset with a preview, no commit and no file', async () => {
      const root = repo();
      const id = await source(root);
      const head = git(root, 'rev-parse', 'HEAD');
      const preview = await cli(['rule', 'migrate', '--to', 'database', '--source', id]);
      expect({ from: preview.from, to: preview.to, applied: preview.applied }).toEqual({ from: null, to: 'database', applied: false });
      expect(await readAccessStore(engine, id)).toBeNull();
      const r = await cli(['rule', 'migrate', '--to', 'database', '--source', id, '--yes']);
      expect({ from: r.from, to: r.to, phase: r.phase }).toEqual({ from: null, to: 'database', phase: 'switched' });
      const journal = await engine.executeRaw<{ direction: string; phase: string }>('SELECT direction, phase FROM access_policy_migrations WHERE source_id = $1', [id]);
      expect({ store: await readAccessStore(engine, id), journal, head: git(root, 'rev-parse', 'HEAD'), dir: existsSync(join(root, '.gbrain')) })
        .toEqual({ store: 'database', journal: [{ direction: 'to_database', phase: 'switched' }], head, dir: false });
      const edit = await cli(['rule', 'import', '--file', policyFile(), '--source', id, '--yes']);
      expect({ store: edit.store, state: edit.state, head: git(root, 'rev-parse', 'HEAD') }).toEqual({ store: 'database', state: 'applied', head });
    }, 120_000);

    test('with owner reads restricted, the preview says the owner loses the narrowed pages while the narrowing is pending', async () => {
      const id = await source(null);
      await engine.executeRaw("INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1, 'partners/alice-example/plan', 'note', 'plan', 'x'), ($1, 'notes', 'note', 'notes', 'x')", [id]);
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', ['owner-example']);
      await engine.setConfig(OWNER_MEMBER_KEY, 'owner-example');
      try {
        const off = await cli(['rule', 'import', '--file', policyFile(), '--source', id]);
        expect(off.owner_reads_pending).toBeUndefined();
        await engine.setConfig(OWNER_READS_RESTRICTED_KEY, '1');
        const on = await cli(['rule', 'import', '--file', policyFile(), '--source', id]);
        expect(on.owner_reads_pending).toEqual({ owner: 'owner-example', pages: 1, prefixes: ['partners/alice-example/'] });
      } finally {
        await engine.unsetConfig(OWNER_READS_RESTRICTED_KEY);
        await engine.unsetConfig(OWNER_MEMBER_KEY);
      }
    }, 120_000);
  });
}

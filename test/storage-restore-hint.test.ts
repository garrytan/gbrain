/**
 * #5532: the restore command `foresights storage status` prints must restore the
 * files it lists as missing. Status counted the source that owns the repo
 * path (dotfile, then longest registered prefix, else every source) while
 * `foresights export --restore-only` picks its source by another rule, so on a
 * multi-source brain the printed command restored another source's pages or
 * refused. Each row runs `storage status`, follows its `Use:` line (with an
 * output dir appended), and compares the restored files with the list.
 *
 * In-memory PGLite; the export destination is a physical path because export
 * publication refuses symlinked ancestors (macOS /var).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runStorage, __resetPGLiteWarn } from '../src/commands/storage.ts';
import { runExport } from '../src/commands/export.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';
import { withEnv } from './helpers/with-env.ts';
import { writeSlugRootMode } from '../src/core/sync-anchor.ts';

let engine: PGLiteEngine;
let dir: string;
let repo: string;
let out: string;
let logged: string[];
const original = { log: console.log, error: console.error, warn: console.warn, exit: process.exit };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'storage-restore-hint-')));
  repo = join(dir, 'repo');
  out = join(dir, 'out');
  mkdirSync(repo);
  writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/x/\n');
  __resetMissingStorageWarning();
  __resetPGLiteWarn();
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw("UPDATE sources SET local_path = NULL WHERE id = 'default'");
  await engine.executeRaw("DELETE FROM config WHERE key = 'sync.repo_path'");
  await engine.executeRaw(
    "INSERT INTO sources (id, name, local_path) VALUES ('connector-a', 'Connector A', NULL)",
  );
  logged = [];
  console.log = console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.warn = () => {};
  process.exit = ((code: number) => { throw new Error(`EXIT:${code}`); }) as never;
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  console.warn = original.warn;
  process.exit = original.exit;
  rmSync(dir, { recursive: true, force: true });
});

async function dbOnlyPage(slug: string, sourceId: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body-${sourceId}`, timeline: '' }, { sourceId });
}

/** A default-source db_only page whose recorded file path is `sourcePath`. */
async function recordedPage(slug: string, sourcePath: string): Promise<void> {
  await dbOnlyPage(slug, 'default');
  await engine.executeRaw("UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2", [sourcePath, slug]);
}

function writeRepoFile(path: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), 'file bytes\n');
}

/** `storage status` output: the listed missing slugs, the warnings and the printed hint. */
async function storageStatus(args: string[]): Promise<{ missing: string[]; warnings: string[]; hint: string }> {
  logged = [];
  await runStorage(engine, ['status', ...args, '--json']);
  const json = JSON.parse(logged.join('\n')) as { missingFiles: Array<{ slug: string }>; warnings: string[] };
  const missing = json.missingFiles.map((m) => m.slug).sort();
  logged = [];
  await runStorage(engine, ['status', ...args]);
  const hint = logged.join('\n').split('\n')
    .find((line) => line.startsWith('Use: ') || line.startsWith('Cannot suggest')) ?? '';
  return { missing, warnings: json.warnings, hint };
}

/** Run the hint's command into `out`; the page slugs it restored. */
/** Split a POSIX shell command line: bare words, '...' and backslash escapes. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '\\') {
      word = (word ?? '') + line[++i];
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

async function followHint(hint: string): Promise<string[]> {
  const argv = shellWords(hint.replace(/^Use: (?:foresights|gbrain) export /, ''));
  logged = [];
  await runExport(engine, [...argv, '--dir', out]);
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name));
      else if (entry.name.endsWith('.md')) files.push(relative(out, join(at, entry.name)).replace(/\.md$/, ''));
    }
  };
  walk(out);
  return files.sort();
}

describe('storage status names a restore command that restores its list (#5532)', () => {
  test.each([
    {
      name: 'legacy sync.repo_path brain with a second source, no --repo',
      args: () => [],
      seed: async () => {
        await engine.setConfig('sync.repo_path', repo);
      },
    },
    {
      name: 'a .gbrain-source in the repo naming another source',
      args: () => ['--repo', repo],
      seed: async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
        writeFileSync(join(repo, '.gbrain-source'), 'connector-a\n');
      },
    },
    {
      // Control row: master already restores the listed file here; it differs
      // only in the hint text (no --source). It pins that the single-owner
      // case keeps working.
      name: 'control: the repo registered to the default source',
      args: () => ['--repo', repo],
      seed: async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
      },
    },
  ])('$name', async ({ args, seed }) => {
    await seed();
    await dbOnlyPage('media/x/default-clip', 'default');
    await dbOnlyPage('media/x/connector-clip', 'connector-a');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(args());
      // Only the default source's page: connector-a's never lived in this repo.
      expect(status.missing).toEqual(['media/x/default-clip']);
      expect(status.hint).toStartWith('Use: foresights export --restore-only --source default ');
      expect(await followHint(status.hint)).toEqual(['media/x/default-clip']);
    });
  });

  test.each([
    {
      name: 'a repo that identifies no single source',
      seed: async () => {
        await engine.setConfig('sync.repo_path', repo);
        await dbOnlyPage('media/x/default-clip', 'default');
        await dbOnlyPage('media/x/connector-clip', 'connector-a');
      },
      reason: 'The restore repo does not identify exactly one source. '
        + 'Pass --source <id> and --repo <path> for that source.',
    },
    {
      name: 'a repo registered only to an archived source',
      seed: async () => {
        await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
        await engine.executeRaw(
          "INSERT INTO sources (id, name, local_path, archived) VALUES ('old', 'Old', $1, true)", [repo],
        );
        await dbOnlyPage('media/x/default-clip', 'default');
      },
      reason: 'The restore repo belongs to archived source "old". '
        + 'Run foresights sources restore old first. Or pass --source <id> and --repo <path> for an active source.',
    },
  ])('$name: status prints the refusal and export refuses it', async ({ seed, reason }) => {
    await seed();

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.hint).toBe(`Cannot suggest a restore command: ${reason}`);

      logged = [];
      await expect(runExport(engine, ['--restore-only', '--repo', repo, '--dir', out])).rejects.toThrow('EXIT:1');
      expect(logged.join('\n')).toContain(`Export failed: ${reason}`);
    });
  });

  // Export's rule matches an archived owner on the exact path only, so for a
  // subdirectory of an archived source's tree it falls back to the only
  // active source. Status keeps refusing that repo, as master's status did.
  test('a repo inside an archived source\'s tree prints a refusal', async () => {
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw(
      "INSERT INTO sources (id, name, local_path, archived) VALUES ('old', 'Old', $1, true)", [dir],
    );
    await dbOnlyPage('media/x/default-clip', 'default');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.hint).toStartWith('Cannot suggest a restore command: Source "old" not found or is archived.');
    });
  });

  test('an active source re-added at an archived source\'s path is restored, not refused', async () => {
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw(
      "INSERT INTO sources (id, name, local_path, archived) VALUES ('old', 'Old', $1, true)", [repo],
    );
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('fresh', 'Fresh', $1)", [repo]);
    await dbOnlyPage('media/x/fresh-clip', 'fresh');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.missing).toEqual(['media/x/fresh-clip']);
      expect(status.hint).toStartWith('Use: foresights export --restore-only --source fresh ');
      expect(await followHint(status.hint)).toEqual(['media/x/fresh-clip']);
    });
  });

  // Export decides "missing" by the page's recorded source_path when it has
  // one, else <slug>.md, for every page under a db_only directory. Status
  // must list exactly those pages.
  test.each([
    {
      name: 'a file present at its recorded source_path is not missing',
      seed: async () => {
        await recordedPage('media/x/my-clip', 'Media/X/My Clip.md');
        writeRepoFile('Media/X/My Clip.md');
        await dbOnlyPage('media/x/gone', 'default');
      },
      missing: ['media/x/gone'] as string[],
    },
    {
      name: 'a <slug>.md file does not stand in for an absent recorded source_path',
      seed: async () => {
        await recordedPage('media/x/moved', 'archive/moved-clip.md');
        writeRepoFile('media/x/moved.md');
      },
      missing: ['media/x/moved'] as string[],
    },
    {
      // The repo is a subdirectory of a git checkout: a recorded path that
      // starts with the repo's path inside the checkout resolves without that
      // prefix, so the same-named file one level deeper does not count.
      name: 'a recorded path carrying the repo prefix inside its git checkout',
      seed: async () => {
        mkdirSync(join(dir, '.git'));
        writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - repo/x/\n');
        await recordedPage('repo/x/clip', 'repo/x/clip.md');
        writeRepoFile('repo/x/clip.md');
      },
      missing: ['repo/x/clip'] as string[],
    },
    {
      name: 'a db_only directory nested in a db_tracked one',
      seed: async () => {
        writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked:\n    - media/\n  db_only:\n    - media/x/\n');
        await dbOnlyPage('media/x/nested', 'default');
      },
      missing: ['media/x/nested'] as string[],
    },
  ])('$name', async ({ seed, missing }) => {
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
    await seed();

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.missing).toEqual(missing);
      expect(await followHint(status.hint)).toEqual(missing);
    });
  });

  // A source pinned to source-root slugs keeps a recorded path that starts
  // with the repo's checkout prefix when the stripped path is not the page's
  // slug; export resolves it in that mode, so status must too.
  test('a source-root source: the recorded path is checked in its slug-root mode', async () => {
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
    await writeSlugRootMode(engine, 'default', 'source-root');
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - repo/x/\n');
      await recordedPage('repo/x/clip', 'repo/x/clip.md');
      writeRepoFile('repo/x/clip.md');
      await dbOnlyPage('repo/x/gone', 'default');

      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        const status = await storageStatus(['--repo', repo]);
        expect(status.missing).toEqual(['repo/x/gone']);
        expect(await followHint(status.hint)).toEqual(['repo/x/gone']);
      });
    } finally {
      await engine.executeRaw("UPDATE sources SET config = config - 'slug_root_mode' WHERE id = 'default'");
    }
  });

  // Export refuses the whole restore on these; status must print that
  // refusal (and name the page under warnings) instead of a command.
  test.each([
    {
      name: 'an unsafe recorded source_path',
      seed: async () => {
        await recordedPage('media/x/escape', '../escape.md');
      },
      slug: 'media/x/escape',
      reason: 'The recorded restore file path is unsafe. Reconcile it before exporting.',
    },
    {
      name: 'a symlinked directory on the restore path',
      seed: async () => {
        mkdirSync(join(dir, 'external-media', 'x'), { recursive: true });
        symlinkSync(join(dir, 'external-media'), join(repo, 'media'));
        await dbOnlyPage('media/x/clip', 'default');
      },
      slug: 'media/x/clip',
      reason: 'The canonical file target has no unambiguous native identity.',
    },
  ])('$name: status prints the refusal export gives', async ({ seed, slug, reason }) => {
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
    // A second db_only dir holds a page that is plainly missing, so status
    // has a missing list to print the refusal under.
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/x/\n    - archive/\n');
    await seed();
    await dbOnlyPage('archive/gone', 'default');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.missing).toContain('archive/gone');
      expect(status.hint).toBe(`Cannot suggest a restore command: ${reason}`);
      expect(status.warnings).toContain(`${slug}: ${reason}`);

      logged = [];
      await expect(runExport(engine, ['--restore-only', '--repo', repo, '--dir', out])).rejects.toThrow('EXIT:1');
      expect(logged.join('\n')).toContain(`Export failed: ${reason}`);
    });
  });

  test('a symlinked directory over every db_only page: one grouped warning and the refusal', async () => {
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
    mkdirSync(join(dir, 'external-media', 'x'), { recursive: true });
    symlinkSync(join(dir, 'external-media'), join(repo, 'media'));
    for (const name of ['a', 'b', 'c']) await dbOnlyPage(`media/x/${name}`, 'default');
    const reason = 'The canonical file target has no unambiguous native identity.';

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.missing).toEqual([]);
      expect(status.warnings).toEqual([`media/x/a and 2 more page(s): ${reason}`]);
      expect(status.hint).toBe(`Cannot suggest a restore command: ${reason}`);
    });
  });

  test('two refusal reasons: warnings and the printed refusal follow the lowest slug, not listing order', async () => {
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/x/\n    - archive/\n');
    mkdirSync(join(dir, 'external-archive'));
    symlinkSync(join(dir, 'external-archive'), join(repo, 'archive'));
    // Written first, so the newest-first page listing returns it last.
    await dbOnlyPage('archive/a', 'default');
    await recordedPage('media/x/z-escape', '../escape.md');
    const symlinked = 'The canonical file target has no unambiguous native identity.';
    const unsafe = 'The recorded restore file path is unsafe. Reconcile it before exporting.';

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', repo]);
      expect(status.warnings).toEqual([`archive/a: ${symlinked}`, `media/x/z-escape: ${unsafe}`]);
      expect(status.hint).toBe(`Cannot suggest a restore command: ${symlinked}`);
    });
  });

  test('a repo path with shell metacharacters round-trips through the quoted hint', async () => {
    const oddRepo = join(dir, `b"r$(touch pwned)\`id\`'s repo`);
    mkdirSync(oddRepo);
    writeFileSync(join(oddRepo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/x/\n');
    await engine.executeRaw("DELETE FROM sources WHERE id = 'connector-a'");
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [oddRepo]);
    await dbOnlyPage('media/x/default-clip', 'default');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const status = await storageStatus(['--repo', oddRepo]);
      expect(status.hint).toEndWith(`--repo '${oddRepo.replace(/'/g, "'\\''")}'`);
      expect(await followHint(status.hint)).toEqual(['media/x/default-clip']);
    });
  });
});

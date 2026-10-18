/**
 * Documented repository paths exist (GBRA-47 DX-2b).
 *
 * Current-state docs (README, CLAUDE.md, AGENTS.md, CONTRIBUTING.md,
 * INSTALL_FOR_AGENTS.md, docs/**, .github/**) tell agents which scripts to run
 * and which tests own a contract. A path to a deleted or renamed `scripts/` or
 * `test/` file sends the reader to nothing, and nothing noticed: deletions
 * left references behind in docs, CONTRIBUTING.md and KEY_FILES. This test
 * fails on any `scripts/...` or `test/...` file path in those docs that does
 * not exist.
 *
 * Not scanned: CHANGELOG.md and TODOS.md (history and backlog), and dated
 * records that describe the tree at the time: docs/test-audit/<date>/,
 * docs/designs/ (plans) and docs/fix-wave-notes/.
 *
 * Escape hatches, in order of preference:
 *  - fix or delete the reference;
 *  - placeholder names (foo, x, your-script, ...) are skipped;
 *  - `<!-- repo-paths: historical -->` exempts the rest of its section (until
 *    the next markdown heading), for former-path tables;
 *  - ALLOWLIST for paths in an operator's own brain or another repository.
 *    It only shrinks; every entry has a reason; a stale entry fails.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const ROOT_DOCS = new Set(['README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'INSTALL_FOR_AGENTS.md']);
const EXEMPT_PREFIXES = ['docs/test-audit/', 'docs/designs/', 'docs/fix-wave-notes/'];
const PATH_RE = /(?<![\w./~-])((?:scripts|test)\/[A-Za-z0-9_./-]*[A-Za-z0-9_])/g;
const FILE_EXT = /\.(ts|mts|mjs|js|sh|tsv|txt|json|jsonl|md|yml)$/;
const PLACEHOLDER = /^(foo|bar|baz|x|y|z|your-[\w-]+)\.[a-z.]+$/;
const HISTORICAL = '<!-- repo-paths: historical -->';

/** file -> path -> reason. Paths that live outside this repository. */
const ALLOWLIST: Record<string, Record<string, string>> = {
  'docs/guides/minions-shell-jobs.md': {
    'scripts/x-garrytan-daily.mjs': 'example shell job running a script in the operator workspace',
    'scripts/fetch.mjs': 'example shell job running a script in the operator workspace',
  },
  'docs/guides/quiet-hours.md': {
    'scripts/quiet-hours-gate.sh': 'gate script the guide has the operator create in their own workspace',
  },
  'docs/guides/multi-source-brains.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'AGENTS.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'INSTALL_FOR_AGENTS.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'docs/GBRAIN_RECOMMENDED_SCHEMA.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'docs/guides/diligence-ingestion.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'docs/guides/live-sync.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'docs/guides/shared-checkout-git.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'docs/architecture/key-files/files-and-sync-1.md': {
    'scripts/brain-commit-push.sh': 'installed into the brain repo by `gbrain sources harden`',
  },
  'docs/UPGRADING_DOWNSTREAM_AGENTS.md': {
    'scripts/validate-frontmatter.mjs': 'downstream agent repo script the upgrade guide tells agents to replace',
  },
  'docs/mcp/HERMES-CLI-PIN.md': {
    'scripts/install.sh': 'the Hermes agent repository installer',
  },
  'docs/architecture/key-files/skills.md': {
    'test/example.test.ts': 'file inside a pack scaffolded by `gbrain skillpack init`',
  },
};

function scannedFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', '*.md', '*.yml', '*.yaml'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  return tracked.filter(f => {
    if (EXEMPT_PREFIXES.some(p => f.startsWith(p))) return false;
    return ROOT_DOCS.has(f) || (f.startsWith('docs/') && f.endsWith('.md')) || f.startsWith('.github/');
  });
}

interface Ref { file: string; line: number; path: string }

function documentedPaths(): Ref[] {
  const refs: Ref[] = [];
  for (const file of scannedFiles()) {
    const full = join(REPO, file);
    if (!existsSync(full)) continue;
    let historical = false;
    readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
      if (text.includes(HISTORICAL)) historical = true;
      else if (/^#{1,6}\s/.test(text)) historical = false;
      if (historical) return;
      for (const m of text.matchAll(PATH_RE)) {
        const path = m[1]!;
        if (!FILE_EXT.test(path) || PLACEHOLDER.test(path.split('/').at(-1)!)) continue;
        refs.push({ file, line: i + 1, path });
      }
    });
  }
  return refs;
}

describe('documented scripts/ and test/ paths', () => {
  const refs = documentedPaths();

  test('every documented path exists', () => {
    const missing = refs
      .filter(r => !existsSync(join(REPO, r.path)) && !ALLOWLIST[r.file]?.[r.path])
      .map(r => `${r.file}:${r.line} names ${r.path}, which does not exist`);
    if (missing.length > 0) {
      throw new Error([
        ...missing,
        'Why: a doc that names a deleted or renamed script or test sends agents to nothing.',
        'Fix: point the reference at the current path or delete it. A former-path table takes `<!-- repo-paths: historical -->` above it; a path in an operator brain or another repository takes a reasoned ALLOWLIST row in test/docs-repo-paths.test.ts.',
        'Docs: docs/TESTING.md#retiring-a-test',
      ].join('\n'));
    }
  });

  test('allowlist entries are still needed', () => {
    const live = new Set(refs.map(r => `${r.file}|${r.path}`));
    const stale = Object.entries(ALLOWLIST).flatMap(([file, paths]) =>
      Object.keys(paths).filter(p => !live.has(`${file}|${p}`) || existsSync(join(REPO, p))).map(p => `${file} › ${p}`));
    expect(stale).toEqual([]);
  });
});

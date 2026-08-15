#!/usr/bin/env bun
/**
 * scripts/generate-template-repo.ts — thin CLI over the template-repo
 * generator core (src/core/bootstrap/template-repo.ts) [D4].
 *
 * Repo-only release/CI tooling — deliberately NOT wired into src/cli.ts.
 * Consumers:
 *   - .github/workflows/release.yml `publish-template` job (generate → byte-
 *     diff against the vendored templates/bootstrap/template-repo/ → push).
 *   - scripts/check-bootstrap-templates.sh part (c): the same byte-diff,
 *     OFFLINE, in `bun run verify` [A1].
 *
 * Usage:
 *   bun run scripts/generate-template-repo.ts --out <dir> [--version X.Y.Z.W]
 *
 * Prints the sorted relative file list to stdout (one per line); diagnostics
 * go to stderr. Exit codes: 0 ok, 1 generation failed (including "render
 * engine not built yet"), 2 usage error.
 */

import { generateTemplateTree } from '../src/core/bootstrap/template-repo.ts';

function usage(): never {
  console.error('usage: bun run scripts/generate-template-repo.ts --out <dir> [--version X.Y.Z.W]');
  process.exit(2);
}

const args = process.argv.slice(2);
let out = '';
let version: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') {
    out = args[++i] ?? '';
  } else if (a === '--version') {
    version = args[++i];
  } else {
    usage();
  }
}
if (!out) usage();

try {
  const res = await generateTemplateTree(out, { version });
  console.error(
    `generate-template-repo: wrote ${res.files.length} files to ${res.outDir} (stamp ${res.version})`,
  );
  for (const f of res.files) console.log(f);
} catch (e) {
  console.error(`generate-template-repo: FAILED — ${(e as Error).message}`);
  process.exit(1);
}

#!/usr/bin/env bun
/**
 * W3 / EO10 — schema migrations must land in version order.
 *
 * The runner applies every migration whose version is above the brain's
 * recorded schema_version. A migration merged with a version at or below the
 * latest one already on origin/master would be skipped forever on every brain
 * that is already current. So every migration on this branch that origin/master
 * does not have must carry a version greater than origin/master's maximum, and
 * a version origin/master already uses must keep origin/master's name.
 *
 * Base ref: $GBRAIN_MIGRATION_BASE_REF, default origin/master. When the ref is
 * missing the check is skipped locally (with a notice) and fails under CI=true.
 * Until W3 is on the base ref, the base's versions are read from its
 * src/core/migrate.ts MIGRATIONS literals. Test seam: GBRAIN_GUARD_ROOT (repo root).
 */

import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { pad, RegistryError, scanMigrations } from './build-schema-migrations.ts';

const REPO = process.env.GBRAIN_GUARD_ROOT ? resolve(process.env.GBRAIN_GUARD_ROOT) : resolve(import.meta.dir, '..');
const SEE = 'See:  docs/TESTING.md#schema-migration-registry';

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** version -> name on the base ref. */
export function baseMigrations(ref: string): Map<number, string> {
  const out = new Map<number, string>();
  const dir = git(['ls-tree', '--name-only', `${ref}:src/core/schema-migrations`]);
  if (dir.ok) {
    for (const f of dir.out.split('\n')) {
      const m = /^v(\d{3,})-([a-z0-9-]+)\.ts$/.exec(f);
      if (m) out.set(Number(m[1]), m[2]!.replace(/-/g, '_'));
    }
    if (out.size > 0) return out;
  }
  const migrate = git(['show', `${ref}:src/core/migrate.ts`]);
  if (!migrate.ok) throw new Error(`cannot read src/core/migrate.ts at ${ref}`);
  const sf = ts.createSourceFile('migrate.ts', migrate.out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let version: number | undefined;
      let name: string | undefined;
      for (const p of node.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
        if (p.name.text === 'version' && ts.isNumericLiteral(p.initializer)) version = Number(p.initializer.text);
        if (p.name.text === 'name' && ts.isStringLiteralLike(p.initializer)) name = p.initializer.text;
      }
      if (version !== undefined && name !== undefined) {
        out.set(version, name);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function main(): number {
  const ref = process.env.GBRAIN_MIGRATION_BASE_REF || 'origin/master';
  if (!git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).ok) {
    const msg = `check-schema-migration-order: base ref ${ref} is not available (git fetch origin master)`;
    if (process.env.CI === 'true') {
      console.error(`FAIL: ${msg}\nWhy:  without the base ref the out-of-order landing check cannot run.\nFix:  fetch it in the workflow (fetch-depth: 0, or git fetch origin +refs/heads/master:refs/remotes/origin/master)\n${SEE}`);
      return 1;
    }
    console.log(`skip: ${msg}`);
    return 0;
  }
  let head;
  try {
    head = scanMigrations(join(REPO, 'src/core/schema-migrations'));
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  const base = baseMigrations(ref);
  if (base.size === 0) {
    console.error(`FAIL: found no schema migrations on ${ref}; the base-ref parser is out of date.\n${SEE}`);
    return 1;
  }
  const baseMax = Math.max(...base.keys());
  const problems: string[] = [];
  for (const m of head) {
    const file = relative(REPO, m.file);
    const baseName = base.get(m.version);
    if (baseName !== undefined) {
      if (baseName !== m.name) {
        problems.push(`FAIL: ${file} reuses version ${m.version}, which ${ref} already assigns to '${baseName}'.`);
      }
      continue;
    }
    if (m.version <= baseMax) {
      problems.push(`FAIL: ${file} adds version ${m.version}, not above ${ref}'s latest version ${baseMax}.`);
    }
  }
  if (problems.length > 0) {
    const next = Math.max(baseMax, ...head.map((m) => m.version)) + 1;
    console.error([
      ...problems,
      `Why:  brains already at schema_version ${baseMax} never run a migration numbered at or below it, so an out-of-order version is skipped forever.`,
      `Fix:  renumber each new migration above every version in use: git mv <file> src/core/schema-migrations/v${pad(next)}-<name>.ts,`,
      `      set \`version: ${next}\` and \`export const v${pad(next)}\` inside it, then run: bun run build:schema-migrations`,
      SEE,
    ].join('\n'));
    return 1;
  }
  const added = head.filter((m) => !base.has(m.version)).map((m) => m.version);
  console.log(`✓ schema migration order: ${added.length} new migration(s) above ${ref}'s latest v${baseMax}${added.length ? ` (${added.join(', ')})` : ''}`);
  return 0;
}

if (import.meta.main) process.exit(main());

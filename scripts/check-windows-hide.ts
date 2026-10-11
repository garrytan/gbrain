#!/usr/bin/env bun
/**
 * Windows hidden-console guard (#4992; docs/TESTING.md#windows-hidden-console-guard).
 *
 * On Windows a detached gbrain child has no console, so every console program
 * it launches without `windowsHide` opens a visible console window that takes
 * focus. src/core/spawn.ts is the one module that launches subprocesses and
 * defaults `windowsHide: true`. Outside it, this guard fails on any runtime
 * use of `child_process` in src/ (a static, dynamic or `require` import that
 * is not type-only) and on any `Bun.spawn` / `Bun.spawnSync` reference, so a
 * NEW spawn site, detached or not, cannot skip the default. It is a RATCHET:
 * NOT_YET_MIGRATED lists the files that still launch directly today, each
 * with its reason; a listed file that no longer does fails as stale, so the
 * list only shrinks. It also fails on an explicit `windowsHide: false` outside
 * ALLOWLIST, which names each deliberate opt-out; a stale entry fails.
 *
 * Fix: import the launcher from src/core/spawn.ts (`spawn`, `spawnSync`,
 * `exec`, `execSync`, `execFile`, `execFileSync`, `bunSpawn`, `bunSpawnSync`)
 * and delete the file's NOT_YET_MIGRATED entry if it has one.
 *
 * Contributed by @rokas-tarasevicius (PR #6105); the ratchet form is wave 14's.
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ANCHOR = 'docs/TESTING.md#windows-hidden-console-guard';
const SEAM = 'src/core/spawn.ts';
const MODULES = new Set(['child_process', 'node:child_process']);

/** Files allowed an explicit `windowsHide: false`. Each entry names its reason; a stale entry fails. */
const ALLOWLIST: Record<string, string> = {
  'src/core/creds/redirect.ts': 'openBrowser launches the system browser through `cmd /c start`; the launch stays as visible as before',
};

/**
 * Files that still import child_process or call Bun.spawn* directly. Delete
 * a file's entry when you move it onto the seam; an entry whose file no
 * longer launches directly fails as stale (the ratchet only goes down).
 */
const NOT_YET_MIGRATED: Record<string, string> = {
  'src/cli/commands/smoke-test.ts': 'not yet migrated',
  'src/commands/bootstrap.ts': 'not yet migrated',
  'src/commands/claw-test.ts': 'not yet migrated',
  'src/commands/connect.ts': 'not yet migrated',
  'src/commands/doctor/bootstrap-checks.ts': 'not yet migrated',
  'src/commands/doctor/checks/git-convergence.ts': 'not yet migrated',
  'src/commands/doctor/checks/local-audits.ts': 'not yet migrated',
  'src/commands/eval-brainbench.ts': 'not yet migrated',
  'src/commands/eval-compare.ts': 'not yet migrated',
  'src/commands/eval-longmemeval.ts': 'not yet migrated',
  'src/commands/eval-run-all.ts': 'not yet migrated',
  'src/commands/frontmatter-install-hook.ts': 'not yet migrated',
  'src/commands/frontmatter.ts': 'not yet migrated',
  'src/commands/hook.ts': 'wave 13 (GBRA-57) file: migrates with that wave',
  'src/commands/import.ts': 'not yet migrated',
  'src/commands/init.ts': 'not yet migrated',
  'src/commands/integrations.ts': 'not yet migrated',
  'src/commands/migrations/in-process.ts': 'not yet migrated',
  'src/commands/migrations/v0_11_0.ts': 'not yet migrated',
  'src/commands/migrations/v0_12_0.ts': 'not yet migrated',
  'src/commands/migrations/v0_12_2.ts': 'not yet migrated',
  'src/commands/migrations/v0_13_0.ts': 'not yet migrated',
  'src/commands/migrations/v0_32_2.ts': 'not yet migrated',
  'src/commands/serve.ts': 'not yet migrated',
  'src/commands/setup.ts': 'not yet migrated',
  'src/commands/skillify-check.ts': 'not yet migrated',
  'src/commands/skillopt.ts': 'not yet migrated',
  'src/commands/skillpack-check.ts': 'not yet migrated',
  'src/commands/sources.ts': 'not yet migrated',
  'src/commands/takes.ts': 'not yet migrated',
  'src/commands/upgrade.ts': 'not yet migrated',
  'src/core/agent-install/setup.ts': 'not yet migrated',
  'src/core/ai/providers/claude-cli-language-model.ts': 'wave 13 (GBRA-57) file: migrates with that wave',
  'src/core/ai/recipes/azure-openai.ts': 'not yet migrated',
  'src/core/binary-self-update.ts': 'not yet migrated',
  'src/core/bootstrap/status.ts': 'not yet migrated',
  'src/core/bootstrap/verify.ts': 'not yet migrated',
  'src/core/brain-repo-durability.ts': 'wave 13 (GBRA-57) file: migrates with that wave',
  'src/core/bun-floor.ts': 'not yet migrated',
  'src/core/calibration/gstack-coupling.ts': 'not yet migrated',
  'src/core/calibration/undo-wave.ts': 'not yet migrated',
  'src/core/claw-test/agent-runner.ts': 'not yet migrated',
  'src/core/claw-test/runners/grok.ts': 'not yet migrated',
  'src/core/claw-test/runners/opencode.ts': 'not yet migrated',
  'src/core/claw-test/transcript-capture.ts': 'not yet migrated',
  'src/core/company-brain/revision.ts': 'not yet migrated',
  'src/core/context/compiled-core.ts': 'not yet migrated',
  'src/core/cycle/derived-write-through.ts': 'not yet migrated',
  'src/core/docker-postgres.ts': 'not yet migrated',
  'src/core/embed-stale-images.ts': 'not yet migrated',
  'src/core/eval/drift-watch.ts': 'not yet migrated',
  'src/core/facts/fence-write.ts': 'not yet migrated',
  'src/core/facts/purge-verify.ts': 'not yet migrated',
  'src/core/fence-repair/census.ts': 'not yet migrated',
  'src/core/fence-repair/repair-io.ts': 'not yet migrated',
  'src/core/fence-repair/uncommitted.ts': 'not yet migrated',
  'src/core/git-first-commit.ts': 'not yet migrated',
  'src/core/git-head.ts': 'not yet migrated',
  'src/core/git-remote.ts': 'not yet migrated',
  'src/core/git-visible-files.ts': 'not yet migrated',
  'src/core/google/access.ts': 'not yet migrated',
  'src/core/hardened-git.ts': 'wave 13 (GBRA-57) file: migrates with that wave',
  'src/core/harness/install.ts': 'not yet migrated',
  'src/core/persistence/engine-graduation.ts': 'not yet migrated',
  'src/core/persistence/sync-blobs.ts': 'not yet migrated',
  'src/core/persistence/sync-discovery.ts': 'not yet migrated',
  'src/core/persistence/topology-filesystem.ts': 'not yet migrated',
  'src/core/pglite-lock.ts': 'not yet migrated',
  'src/core/repair/frontmatter.ts': 'not yet migrated',
  'src/core/repair/slug-conflicts.ts': 'not yet migrated',
  'src/core/repo-visibility.ts': 'not yet migrated',
  'src/core/shared-skills/migration-export.ts': 'not yet migrated',
  'src/core/shared-skills/setup.ts': 'not yet migrated',
  'src/core/skill-fix-gates.ts': 'not yet migrated',
  'src/core/skillopt/apply-edits.ts': 'not yet migrated',
  'src/core/skillpack/bundle.ts': 'not yet migrated',
  'src/core/skillpack/endorse.ts': 'not yet migrated',
  'src/core/skillpack/remote-source.ts': 'not yet migrated',
  'src/core/skillpack/tarball.ts': 'not yet migrated',
  'src/core/source-health.ts': 'not yet migrated',
  'src/core/sync-delta.ts': 'not yet migrated',
  'src/core/sync-git.ts': 'not yet migrated',
  'src/core/sync-reconcile.ts': 'not yet migrated',
  'src/core/sync-upstream.ts': 'not yet migrated',
  'src/core/tailscale.ts': 'not yet migrated',
  'src/core/thin-client-upgrade-prompt.ts': 'not yet migrated',
  'src/core/transcription.ts': 'not yet migrated',
  'src/eval/brainbench/trust-scenario.ts': 'not yet migrated',
  'src/eval/code-retrieval/harness.ts': 'not yet migrated',
};

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const isModule = (node: ts.Node | undefined): boolean => !!node && ts.isStringLiteralLike(node) && MODULES.has(node.text);

/** An import that loads child_process at runtime (not `import type`, not all-`type` specifiers). */
function valueImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    return !bindings || ts.isNamespaceImport(bindings) || bindings.elements.length === 0 || bindings.elements.some(e => !e.isTypeOnly);
  }
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  return !clause || !ts.isNamedExports(clause) || clause.elements.some(e => !e.isTypeOnly);
}

const violations: string[] = [];
const optedOut = new Set<string>();
const launchesDirectly = new Set<string>();
for (const abs of tsFiles(join(ROOT, 'src'))) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  if (rel === SEAM) continue;
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fail = (node: ts.Node, code: string, what: string, fix: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    violations.push(`FAIL [${code}]: ${rel}:${line} ${what}\n      Fix: ${fix}`);
  };
  const direct = (node: ts.Node, code: string, what: string, fix: string) => {
    launchesDirectly.add(rel);
    if (!NOT_YET_MIGRATED[rel]) fail(node, code, what, fix);
  };
  const useSeam = `import it from ${SEAM}, which defaults windowsHide: true`;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isModule(node.moduleSpecifier) && valueImport(node)) {
      direct(node, 'windows_hide_direct_child_process', 'imports child_process directly', useSeam);
    } else if (ts.isCallExpression(node) && isModule(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      direct(node, 'windows_hide_direct_child_process', `loads child_process with ${node.expression.getText(sf)}()`, useSeam);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Bun'
      && (node.name.text === 'spawn' || node.name.text === 'spawnSync')) {
      const wrapper = node.name.text === 'spawn' ? 'bunSpawn' : 'bunSpawnSync';
      direct(node, 'windows_hide_direct_bun_spawn', `calls Bun.${node.name.text}`, `call ${wrapper} from ${SEAM}, which defaults windowsHide: true`);
    } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
      && node.name.text === 'windowsHide' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      optedOut.add(rel);
      if (!ALLOWLIST[rel]) fail(node, 'windows_hide_opt_out', 'sets windowsHide: false', `drop it, or add ${rel} to ALLOWLIST in scripts/check-windows-hide.ts with the reason the window must show`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const [rel, reason] of Object.entries(ALLOWLIST)) {
  if (existsSync(join(ROOT, rel)) && !optedOut.has(rel)) {
    violations.push(`FAIL [windows_hide_stale_allowlist]: ${rel} no longer sets windowsHide: false (allowlisted: ${reason})\n      Fix: delete its ALLOWLIST entry in scripts/check-windows-hide.ts`);
  }
}
for (const [rel, reason] of Object.entries(NOT_YET_MIGRATED)) {
  if (existsSync(join(ROOT, rel)) && !launchesDirectly.has(rel)) {
    violations.push(`FAIL [windows_hide_stale_migration_entry]: ${rel} no longer launches subprocesses directly (listed: ${reason})\n      Fix: delete its NOT_YET_MIGRATED entry in scripts/check-windows-hide.ts; the ratchet only goes down`);
  }
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  on Windows a console program launched from a detached gbrain process without windowsHide opens a visible console window that takes focus (#4992).');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-windows-hide: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`check-windows-hide: ok (src/, seam ${SEAM}, ${Object.keys(ALLOWLIST).length} allowlisted opt-out, ${Object.keys(NOT_YET_MIGRATED).length} not yet migrated)`);

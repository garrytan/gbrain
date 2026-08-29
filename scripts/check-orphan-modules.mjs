#!/usr/bin/env node
// check-orphan-modules.mjs — transitive-reachability guard for src/ modules.
//
// Walks static `from '...'`, dynamic `import('...')`, and `require('...')`
// RELATIVE specifiers from the runtime entrypoints (CLI, MCP server, plugin
// engines, embedded admin) plus every package.json `exports` target, and
// fails when a src/**/*.ts module is unreachable and not on the reasoned
// allowlist below. An orphan module is dead weight that still compiles,
// still greps, and silently rots (the minion-spend class: a spend-cap
// module with zero callers meant the cap was off in production).
//
// Tooling decision (test-gap plan B4, boring-by-default evaluated first):
// knip v5 was tried and REJECTED with evidence — `bunx knip@5` hard-crashes
// on this repo's layout (ENOTDIR scandir on test/**.test.ts during its
// workspace scan, with and without ignore globs, 2026-08-25), and the
// repo's deliberate lazy `require()`/`import()` seams (the
// `engine-dynamic-import-ok` sites) would need per-site annotations anyway.
// This walker counts BOTH static and dynamic relative imports, so those
// lazy seams are reachable by construction.
//
// Self-test seam: argv[2] (or GBRAIN_GUARD_ROOT) points at a fixture tree;
// in fixture mode the entries are `src/entry*.ts` and the allowlist is
// empty, so scripts/guard-self-test.sh can prove the guard fails on bad
// and passes on good fixtures.
//
// Exit: 0 clean · 1 orphans or stale allowlist entries · 2 infra error.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const root = process.argv[2] || process.env.GBRAIN_GUARD_ROOT || '.';
const fixtureMode = !!(process.argv[2] || process.env.GBRAIN_GUARD_ROOT);

// Reasoned allowlist (repo mode only). SHRINK-ONLY: a stale entry (module
// became reachable or was deleted) fails the guard so the list can't rot.
const ALLOWLIST = new Map([
  // Alternate chunker strategies kept as documented options for the chunker
  // registry; selectable via config in a future wave, currently unreferenced.
  ['src/core/chunkers/semantic.ts', 'alternate chunker strategy, config-selectable follow-up'],
  ['src/core/chunkers/llm.ts', 'alternate chunker strategy, config-selectable follow-up'],
  // Standalone single-arm search entrypoints superseded by search/hybrid's
  // internal arms; retained for the eval harness comparison work.
  ['src/core/search/keyword.ts', 'single-arm search kept for eval comparisons'],
  ['src/core/search/vector.ts', 'single-arm search kept for eval comparisons'],
]);

// Modules unreachable from RUNTIME entrypoints but imported (transitively)
// by the test tree are a separate, softer tier: not dead code, but not
// product code either — candidates for wiring or deletion. Their COUNT is a
// shrink-only ratchet so the tier can't quietly grow.
const MAX_TEST_ONLY_REACHABLE = 46;

function walkDir(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === '.git') continue;
      walkDir(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) {
    console.error(`check-orphan-modules: no src/ under ${root}`);
    process.exit(2);
  }
  const srcFiles = walkDir(srcDir).map(p => relative(root, p));
  const srcSet = new Set(srcFiles);

  let entries = [];
  if (fixtureMode) {
    entries = srcFiles.filter(f => /(^|\/)entry[^/]*\.ts$/.test(f));
  } else {
    entries = [
      'src/cli.ts',
      'src/mcp/server.ts',
      'src/openclaw-context-engine.ts',
      'src/admin-embedded.ts',
    ].filter(f => srcSet.has(f));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const target of Object.values(pkg.exports ?? {})) {
      const rel = String(target).replace(/^\.\//, '');
      if (srcSet.has(rel)) entries.push(rel);
    }
  }
  if (entries.length === 0) {
    console.error('check-orphan-modules: no entrypoints found');
    process.exit(2);
  }

  // Relative-specifier extraction: static, dynamic, and require forms.
  const IMPORT_RE = /(?:from\s+|import\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g;
  const resolveSpec = (fromFile, spec) => {
    const base = join(root, dirname(fromFile), spec);
    for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
      const rel = relative(root, cand);
      if (srcSet.has(rel)) return rel;
    }
    return null;
  };

  const crawl = (seedFiles) => {
    const seen = new Set();
    const stack = [...seedFiles];
    while (stack.length > 0) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      let text;
      try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
      let m;
      const re = new RegExp(IMPORT_RE.source, 'g');
      while ((m = re.exec(text)) !== null) {
        const dep = resolveSpec(f, m[1]);
        if (dep && !seen.has(dep)) stack.push(dep);
      }
    }
    return seen;
  };

  const runtimeReachable = crawl(entries);

  // Test-tree reachability (repo mode): seed with test files but only track
  // src/ members in the result set. Test files resolve into src via relative
  // specifiers; the crawl handles the rest transitively.
  let testReachable = new Set();
  if (!fixtureMode && existsSync(join(root, 'test'))) {
    const testFiles = [];
    (function walkTests(dir) {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        const st = statSync(p);
        if (st.isDirectory()) walkTests(p);
        else if (p.endsWith('.ts')) testFiles.push(relative(root, p));
      }
    })(join(root, 'test'));
    const allSeen = new Set();
    const stack = [...testFiles];
    while (stack.length > 0) {
      const f = stack.pop();
      if (allSeen.has(f)) continue;
      allSeen.add(f);
      let text;
      try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
      let m;
      const re = new RegExp(IMPORT_RE.source, 'g');
      while ((m = re.exec(text)) !== null) {
        const base = join(root, dirname(f), m[1]);
        for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
          const rel = relative(root, cand);
          if (srcSet.has(rel) || rel.startsWith('test/')) {
            if (!allSeen.has(rel)) stack.push(rel);
            break;
          }
        }
      }
    }
    testReachable = new Set([...allSeen].filter(f => srcSet.has(f)));
  }

  const allow = fixtureMode ? new Map() : ALLOWLIST;
  const notRuntime = srcFiles.filter(f => !runtimeReachable.has(f));
  const hardOrphans = notRuntime.filter(f => !testReachable.has(f) && !allow.has(f)).sort();
  const testOnly = notRuntime.filter(f => testReachable.has(f) && !allow.has(f)).sort();
  const stale = [...allow.keys()].filter(f => !srcSet.has(f) || runtimeReachable.has(f)).sort();

  let failed = false;
  if (hardOrphans.length > 0) {
    failed = true;
    console.error(`FAIL: ${hardOrphans.length} src module(s) unreachable from every RUNTIME entrypoint AND every test, not allowlisted:`);
    for (const f of hardOrphans) console.error(`  ${f}`);
    console.error('  Wire the module, delete it, or add a reasoned allowlist entry in scripts/check-orphan-modules.mjs.');
  }
  if (!fixtureMode && testOnly.length > MAX_TEST_ONLY_REACHABLE) {
    failed = true;
    console.error(`FAIL: test-only-reachable tier grew to ${testOnly.length} (ratchet ceiling ${MAX_TEST_ONLY_REACHABLE}):`);
    for (const f of testOnly) console.error(`  ${f}`);
    console.error('  New src modules must be reachable from a runtime entrypoint; wire it or (for a deliberate test-only helper) raise the ceiling in a reviewer-visible edit.');
  }
  if (stale.length > 0) {
    failed = true;
    console.error(`FAIL: ${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} (now runtime-reachable or deleted) — shrink the list:`);
    for (const f of stale) console.error(`  ${f}`);
  }
  if (failed) process.exit(1);
  console.log(
    `check-orphan-modules: OK (${srcFiles.length} modules, ${entries.length} entrypoints, ` +
    `${allow.size} allowlisted, ${testOnly.length}/${MAX_TEST_ONLY_REACHABLE} test-only-reachable)`,
  );
}

main();

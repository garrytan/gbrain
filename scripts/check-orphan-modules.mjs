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
// in fixture mode the entries are `src/entry*.ts`, the hard-orphan
// allowlist is empty, and the permitted test-only set is read from
// `<root>/permitted-test-only.json` (absent = empty), so
// scripts/guard-self-test.sh and test/scripts/check-orphan-modules.test.ts
// can prove every rule fails on bad and passes on good trees.
//
// Exit: 0 clean · 1 orphans, unpermitted test-only modules, or stale
// entries · 2 infra error.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const root = process.argv[2] || process.env.GBRAIN_GUARD_ROOT || '.';
const fixtureMode = !!(process.argv[2] || process.env.GBRAIN_GUARD_ROOT);

const RERUN = 'bun run check:orphan-modules';
const DOCS = 'docs/TESTING.md#orphan-module-guard';
const SELF = 'scripts/check-orphan-modules.mjs';

// Hard-orphan allowlist (repo mode only): modules imported by nothing, not
// even tests. SHRINK-ONLY: a stale entry (module became reachable or was
// deleted) fails the guard so the list can't rot.
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

// Permitted test-only modules (repo mode): unreachable from every runtime
// entrypoint but imported by the test tree. Every such module must be named
// here with a reason; a test-only module missing from the set fails, and an
// entry that is deleted, wired into a runtime entrypoint, or no longer
// imported by any test fails as stale. The set may grow only with a reason
// string in a reviewer-visible edit. Modules reached from `scripts/**` carry
// reason 'script-reachable', which the guard verifies.
const PERMITTED_TEST_ONLY = [
  { path: 'src/core/bootstrap/template-repo.ts', reason: 'script-reachable' },
  { path: 'src/core/eval-contradictions/fixture-redact.ts', reason: 'script-reachable' },
  { path: 'src/eval/longmemeval/diagnostics.ts', reason: 'script-reachable' },
  { path: 'src/eval/longmemeval/evidence-packet.ts', reason: 'script-reachable' },
  { path: 'src/eval/shared/autocut-replay.ts', reason: 'script-reachable' },
  { path: 'src/mcp/http-transport.ts', reason: 'script-reachable' },
  { path: 'src/mcp/tool-catalog.ts', reason: 'script-reachable' },
  { path: 'src/core/archive-crawler-config.ts', reason: "held: skills/archive-crawler/SKILL.md describes the scan_paths safety fence as code-enforced; wire-or-retract is a product decision" },
  { path: 'src/core/chronicle/backstop.ts', reason: 'held: the put_page chronicle backstop was dropped in v0.51.0.0, so the documented auto_chronicle setting does nothing; restore-or-retract is a product decision' },
  { path: 'src/core/onboard/impact-capture.ts', reason: 'held: sole writer of migration_impact_log, which the shipped `gbrain onboard --history` reads; wire-or-retract is a product decision' },
  { path: 'src/core/progressive-batch/orchestrator.ts', reason: 'held: TODOS.md keeps an open item to re-compose progressive-batch with --workers on the 3 reindex sites (callers dropped in the v0.41.17.0 merge)' },
  { path: 'src/core/progressive-batch/retrofit-wrap.ts', reason: 'held: progressive-batch re-compose item still open in TODOS.md' },
  { path: 'src/core/progressive-batch/stage-report.ts', reason: 'held: progressive-batch re-compose item still open in TODOS.md' },
  { path: 'src/core/ingestion/daemon.ts', reason: 'held: ingestion cluster awaits a wire-up vs delete product decision (public gbrain/ingestion export, docs/guides/data-ingestion.md)' },
  { path: 'src/core/ingestion/dedup.ts', reason: 'held: ingestion cluster awaits a wire-up vs delete product decision' },
  { path: 'src/core/ingestion/skillpack-load.ts', reason: 'held: ingestion cluster awaits a wire-up vs delete product decision' },
  { path: 'src/core/ingestion/sources/file-watcher.ts', reason: 'held: ingestion cluster awaits a wire-up vs delete product decision' },
  { path: 'src/core/ingestion/sources/gstack-learnings.ts', reason: 'held: ingestion cluster awaits a wire-up vs delete product decision' },
  { path: 'src/core/ingestion/sources/inbox-folder.ts', reason: 'held: ingestion cluster awaits a wire-up vs delete product decision (docs/guides/data-ingestion.md promises the inbox folder)' },
  { path: 'src/core/ingestion/sources/markdown-greenfield.ts', reason: 'held: ingestion cluster awaits a wire-up vs delete product decision (docs/migrations/v0.41.2-markdown-greenfield.md)' },
];

const RULES = {
  hardOrphan: 'orphan-modules/hard-orphan',
  unpermitted: 'orphan-modules/unpermitted-test-only',
  invalidEntry: 'orphan-modules/invalid-permitted-entry',
  stalePermitted: 'orphan-modules/stale-permitted-entry',
  staleAllowlist: 'orphan-modules/stale-allowlist-entry',
};

function walkDir(dir, match, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === '.git') continue;
      walkDir(p, match, out);
    } else if (match(p)) {
      out.push(p);
    }
  }
  return out;
}

function loadPermitted() {
  if (!fixtureMode) return PERMITTED_TEST_ONLY;
  const file = join(root, 'permitted-test-only.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`check-orphan-modules: cannot parse ${file}: ${err.message}`);
    process.exit(2);
  }
}

function report(rule, path, lines) {
  console.error(`FAIL [${rule}] ${path}`);
  for (const line of lines) console.error(`  ${line}`);
  console.error(`  rerun: ${RERUN}`);
  console.error(`  docs: ${DOCS}`);
}

function main() {
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) {
    console.error(`check-orphan-modules: no src/ under ${root}`);
    process.exit(2);
  }
  const isTs = (p) => p.endsWith('.ts') && !p.endsWith('.d.ts');
  const srcFiles = walkDir(srcDir, isTs).map(p => relative(root, p));
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
      // Package-shipped scripts/setup-in-agent.sh invokes this finite setup entry directly.
      'src/core/agent-install/entry.ts',
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
  const resolveSpec = (fromFile, spec, allowOutsideSrc) => {
    const base = join(root, dirname(fromFile), spec);
    for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
      const rel = relative(root, cand);
      if (srcSet.has(rel)) return rel;
      if (allowOutsideSrc && allowOutsideSrc(rel) && existsSync(cand) && statSync(cand).isFile()) return rel;
    }
    return null;
  };

  // Crawls from seed files; files outside src/ are followed only when
  // `allowOutsideSrc` accepts them. Records each file's direct importers.
  const crawl = (seedFiles, allowOutsideSrc) => {
    const seen = new Set();
    const importers = new Map();
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
        const dep = resolveSpec(f, m[1], allowOutsideSrc);
        if (!dep) continue;
        if (!importers.has(dep)) importers.set(dep, new Set());
        importers.get(dep).add(f);
        if (!seen.has(dep)) stack.push(dep);
      }
    }
    return { seen, importers };
  };

  const runtimeReachable = crawl(entries).seen;

  const testSeeds = walkDir(join(root, 'test'), (p) => p.endsWith('.ts')).map(p => relative(root, p));
  const testCrawl = crawl(testSeeds, (rel) => rel.startsWith('test/'));
  const testReachable = new Set([...testCrawl.seen].filter(f => srcSet.has(f)));

  const scriptSeeds = walkDir(join(root, 'scripts'), (p) => /\.(ts|mjs|js)$/.test(p)).map(p => relative(root, p));
  const scriptCrawl = crawl(scriptSeeds, (rel) => rel.startsWith('scripts/'));
  const scriptReachable = new Set([...scriptCrawl.seen].filter(f => srcSet.has(f)));

  const allow = fixtureMode ? new Map() : ALLOWLIST;
  const permittedList = loadPermitted();
  const permitted = new Map();
  const invalid = [];
  for (const entry of permittedList) {
    const path = entry?.path;
    if (typeof path !== 'string' || path.length === 0) {
      invalid.push({ path: JSON.stringify(entry), why: 'entry has no path' });
    } else if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      invalid.push({ path, why: 'entry has no reason; every permitted test-only module needs one' });
    } else if (permitted.has(path)) {
      invalid.push({ path, why: 'duplicate entry' });
    } else {
      permitted.set(path, entry.reason);
    }
  }

  const testImporters = (f) => {
    const direct = [...(testCrawl.importers.get(f) ?? [])].sort();
    const fromTests = direct.filter(p => p.startsWith('test/'));
    return fromTests.length > 0 ? fromTests : direct;
  };

  const notRuntime = srcFiles.filter(f => !runtimeReachable.has(f));
  const hardOrphans = notRuntime.filter(f => !testReachable.has(f) && !allow.has(f) && !permitted.has(f)).sort();
  const testOnly = notRuntime.filter(f => testReachable.has(f) && !allow.has(f)).sort();
  const unpermitted = testOnly.filter(f => !permitted.has(f));

  const stalePermitted = [];
  for (const [path, reason] of permitted) {
    if (!srcSet.has(path)) stalePermitted.push({ path, why: 'the module no longer exists' });
    else if (runtimeReachable.has(path)) stalePermitted.push({ path, why: 'the module is now reachable from a runtime entrypoint' });
    else if (!testReachable.has(path)) stalePermitted.push({ path, why: 'no test imports the module any more' });
    else if (reason === 'script-reachable' && !scriptReachable.has(path)) stalePermitted.push({ path, why: "tagged 'script-reachable' but no scripts/** file imports it" });
  }
  stalePermitted.sort((a, b) => a.path.localeCompare(b.path));
  const staleAllow = [...allow.keys()].filter(f => !srcSet.has(f) || runtimeReachable.has(f)).sort();

  for (const f of hardOrphans) {
    report(RULES.hardOrphan, f, [
      'reason: unreachable from every runtime entrypoint and every test',
      `remedy: wire the module into a runtime caller or delete it; a deliberate keep needs a reasoned ALLOWLIST entry in ${SELF}`,
    ]);
  }
  for (const f of unpermitted) {
    const via = testImporters(f);
    report(RULES.unpermitted, f, [
      `imported by: ${via.length > 0 ? via.join(', ') : '(transitively, via the test tree)'}`,
      'reason: reachable from tests but from no runtime entrypoint (cli, mcp server, plugin engines, admin, package exports)',
      `remedy: wire the module into a runtime caller, delete it with its tests, or add { path, reason } to PERMITTED_TEST_ONLY in ${SELF} (reason 'script-reachable' when scripts/** imports it)`,
    ]);
  }
  for (const { path, why } of invalid) {
    report(RULES.invalidEntry, path, [
      `reason: ${why}`,
      `remedy: fix the record in PERMITTED_TEST_ONLY in ${SELF}`,
    ]);
  }
  for (const { path, why } of stalePermitted) {
    report(RULES.stalePermitted, path, [
      `reason: ${why}`,
      `remedy: remove this record from PERMITTED_TEST_ONLY in ${SELF} (or correct its reason); do not restore code to satisfy the list`,
    ]);
  }
  for (const f of staleAllow) {
    report(RULES.staleAllowlist, f, [
      'reason: allowlisted as a hard orphan but now runtime-reachable or deleted',
      `remedy: remove this record from ALLOWLIST in ${SELF}; do not restore code to satisfy the list`,
    ]);
  }

  const failures = hardOrphans.length + unpermitted.length + invalid.length + stalePermitted.length + staleAllow.length;
  if (failures > 0) {
    console.error(`check-orphan-modules: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(
    `check-orphan-modules: OK (${srcFiles.length} modules, ${entries.length} entrypoints, ` +
    `${allow.size} allowlisted, ${testOnly.length} permitted test-only)`,
  );
}

main();

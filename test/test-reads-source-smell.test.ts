/**
 * #3665 — source-text-assertion smell gate.
 *
 * A test whose assertions run over src/ TEXT pins spelling, not behavior: it
 * keeps passing when the behavior breaks in a way that preserves the grepped
 * token, and it breaks when a harmless rename lands. Sometimes that is exactly
 * the right tool, but it must be a deliberate, reviewable choice.
 *
 * Detected read sites: a `readFileSync(` / `readFile(` (including
 * `fs.promises.readFile(`) / `Bun.file(` call whose balanced argument span
 * names a src path — a string literal containing `src/`, a `'src'` path
 * segment (e.g. `join(ROOT, 'src', 'core', 'x.ts')`), or a constant whose
 * initializer holds such a path (followed transitively).
 *
 * Rule: a read site needs a tagged marker on its line or within the 3 lines
 * above:
 *
 *   // test-reads-source-ok[<category>]: <why>
 *
 * with one category from MARKER_TAGS. Every marker must carry a category.
 * Files that predate the rule are ratcheted by their exact count of
 * unjustified read sites in GRANDFATHERED: a new unjustified read in such a
 * file fails, and a count that drops must be lowered here. The ratchet counts
 * read sites only; new assertions over an existing source binding are the
 * authoring gate's responsibility (docs/TESTING.md#authoring-gate).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const TEST_DIR = import.meta.dir;
const FIXTURE_DIR = join(TEST_DIR, 'fixtures', 'source-read-smell');
const SELF = 'test-reads-source-smell.test.ts';

const RULE = 'test-reads-source';
const RERUN = 'bun test test/test-reads-source-smell.test.ts';
const DOC = 'docs/TESTING.md#source-reads-in-tests';
const MARKER = 'test-reads-source-ok';
const MARKER_TAGS = ['prompt-byte', 'trust-boundary', 'generated-artifact', 'structural', 'raw-bytes'] as const;
const TAGGED_MARKER = new RegExp(`${MARKER}\\[(?:${MARKER_TAGS.join('|')})\\]:\\s*\\S`);

const READ_FNS = new Set(['readFileSync', 'readFile']);
const SRC_PATH = /^(?:(?:\.{1,2}\/)+|\/)?(?:admin\/)?src(?:\/|$)/;

/**
 * Exact unjustified read-site counts for files that predate the rule. Never
 * add an entry or raise a count: tag the read with a marker, or assert
 * runtime behavior instead. Lower or remove an entry when sites go away.
 */
const GRANDFATHERED: Record<string, number> = {
  'admin-sse-eventsource.test.ts': 1,
  'agent-register.test.ts': 2,
  'ai/silent-drop-regression.test.ts': 2,
  'apply-migrations.test.ts': 3,
  'archived-source-scoping.test.ts': 1,
  'autopilot-auto-drain-wiring.test.ts': 1,
  'autopilot-cycle-failure-classification.test.ts': 2,
  'autopilot-fanout-wiring.test.ts': 2,
  'autopilot-install.test.ts': 5,
  'autopilot-nightly-probe-wiring.test.ts': 1,
  'autopilot-parser-probe-wiring.test.ts': 1,
  'autopilot-pause-marker.test.ts': 1,
  'autopilot-self-upgrade.test.ts': 1,
  'autopilot-shutdown-engine-close.test.ts': 1,
  'autopilot-supervisor-wiring.test.ts': 1,
  'backup-cli.serial.test.ts': 2,
  'backup-invalidation.serial.test.ts': 1,
  'book-mirror.test.ts': 1,
  'brain-score-breakdown.test.ts': 1,
  'brainstorm-timeout.test.ts': 2,
  'check-update.test.ts': 1,
  'child-worker-supervisor.test.ts': 1,
  'chunkers/code-bash.test.ts': 2,
  'claude-cli-recipe.test.ts': 1,
  'cli-force-exit-teardown-arming.test.ts': 2,
  'compile-view.test.ts': 1,
  'config.test.ts': 1,
  'connection-resilience.test.ts': 3,
  'contextual-retrieval-service-pure.test.ts': 1,
  'conversation-facts-type-allowlist-drift.test.ts': 1,
  'cycle-abort.test.ts': 7,
  'cycle-drain-renewal.test.ts': 2,
  'cycle-patterns-deadline-budget.test.ts': 5,
  'cycle-phase-deadline-drift.test.ts': 2,
  'cycle/nightly-probe-adapters.test.ts': 5,
  'cycle/regression-pr-wave-r1-r2-r4.test.ts': 2,
  'cycle/yield-during-phase-throttle.test.ts': 1,
  'destructive-guard.test.ts': 1,
  'detached-stderr.test.ts': 1,
  'doctor-categories.test.ts': 1,
  'doctor-orphan-ratio.test.ts': 3,
  'doctor-volunteer-channels.test.ts': 3,
  'doctor.test.ts': 1,
  'embedding-dim-check-facts.test.ts': 1,
  'eval-capture-db-plane.serial.test.ts': 2,
  'eval-synthesize-concepts-routing.test.ts': 2,
  'exit-classification.test.ts': 2,
  'extract-atoms-drain-errors.test.ts': 1,
  'extract-atoms-drain.test.ts': 3,
  'features.test.ts': 2,
  'fence-extraction.test.ts': 1,
  'files.test.ts': 2,
  'fix-wave-structural.test.ts': 35,
  'hook-command.serial.test.ts': 1,
  'integrations.test.ts': 1,
  'jobs-embed-background-parity.serial.test.ts': 2,
  'jobs-gateway-refresh-set.test.ts': 1,
  'jobs-list-get-json.serial.test.ts': 1,
  'jobs-thin-client-date-rehydration.test.ts': 1,
  'jobs-worker-startup-recovery.test.ts': 1,
  'lens-pack-manifests.test.ts': 1,
  'link-inference-pack.test.ts': 1,
  'link-source-check-repair.test.ts': 1,
  'longmemeval-embed-cache.test.ts': 1,
  'loops-extract-wiring.test.ts': 2,
  'migrate-stdout-clean.test.ts': 1,
  'migrate.test.ts': 11,
  'migration-in-process.serial.test.ts': 3,
  'migration-resume.test.ts': 6,
  'migrations-v0_13_0.test.ts': 4,
  'migrations-v0_14_0.test.ts': 4,
  'migrations-v0_22_4.test.ts': 1,
  'model-pricing.test.ts': 1,
  'openclaw-plugin-manifest.test.ts': 1,
  'operations-trust-boundary.test.ts': 1,
  'pglite-engine.test.ts': 1,
  'pglite-wal-repair.serial.test.ts': 1,
  'postgres-engine.test.ts': 1,
  'redos-hardening.test.ts': 2,
  'register-client-source-normalize.test.ts': 1,
  'reindex-code-recovery.test.ts': 1,
  'reranker-default-seam.test.ts': 1,
  'retrieval-reflex-recipe-routing.test.ts': 1,
  'schema-bootstrap-coverage.test.ts': 5,
  'schema-pack-best-effort.test.ts': 1,
  'schema-pack-unify-types-handler.test.ts': 2,
  'schema-pack/suggest.test.ts': 1,
  'search/graph-signals-wire-integration.test.ts': 1,
  'search/knobs-hash-reranker.test.ts': 2,
  'serve-http-admin-route-guard.test.ts': 1,
  'serve-http-github-webhook.test.ts': 1,
  'serve-http-mcp-transport-cleanup.test.ts': 1,
  'skillpack-scaffold.test.ts': 1,
  'sources-webhook.test.ts': 1,
  'spend-off-switch.test.ts': 3,
  'supervisor.test.ts': 1,
  'sync-failures.test.ts': 6,
  'sync-include-hidden.test.ts': 1,
  'sync.test.ts': 1,
  'timing-safe.test.ts': 1,
  'transcript-adapters.test.ts': 1,
  'transcription-injection.test.ts': 1,
  'v0_37_fix_wave.serial.test.ts': 2,
  'v0_37_gap_fill.serial.test.ts': 3,
  'worker-lock-renewal-shape.test.ts': 1,
  'worker-supervised-db-probe.test.ts': 1,
};

function isReadCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return READ_FNS.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (READ_FNS.has(callee.name.text)) return true;
  return callee.name.text === 'file' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Bun';
}

/** True when the subtree holds a src path literal, a 'src' segment, or a src-path constant. */
function namesSrcPath(node: ts.Node, srcConsts: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (SRC_PATH.test(n.text)) found = true;
    } else if (ts.isIdentifier(n) && srcConsts.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const PATH_BUILDER = /join|resolve|normalize|url/i;

/** A declaration initializer that builds a path: a literal, template, concatenation or path-builder call. */
function isPathExpression(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isIdentifier(node) || ts.isBinaryExpression(node)) return true;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    return PATH_BUILDER.test(name);
  }
  return false;
}

function containsReadCall(node: ts.Node): boolean {
  if (isReadCall(node)) return true;
  return ts.forEachChild(node, containsReadCall) ?? false;
}

type FileScan = { unjustified: number[]; untaggedMarkers: number[] };

function scanSource(text: string): FileScan {
  const lines = text.split('\n');
  const untaggedMarkers = lines
    .map((l, i) => (l.includes(MARKER) && !TAGGED_MARKER.test(l) ? i + 1 : 0))
    .filter(Boolean);
  if (!/readFile|Bun\.file/.test(text)) return { unjustified: [], untaggedMarkers };

  const sf = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decls: ts.VariableDeclaration[] = [];
  const reads: ts.CallExpression[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isPathExpression(n.initializer) && !containsReadCall(n.initializer)) decls.push(n);
    if (isReadCall(n)) reads.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const srcConsts = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const d of decls) {
      const name = (d.name as ts.Identifier).text;
      if (!srcConsts.has(name) && namesSrcPath(d.initializer!, srcConsts)) {
        srcConsts.add(name);
        grew = true;
      }
    }
  }

  const sites = new Set<number>();
  for (const call of reads) {
    if (call.arguments.some((a) => namesSrcPath(a, srcConsts))) {
      sites.add(sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1);
    }
  }
  const unjustified = [...sites].sort((a, b) => a - b).filter((line) => {
    const context = lines.slice(Math.max(0, line - 4), line);
    return !context.some((l) => TAGGED_MARKER.test(l));
  });
  return { unjustified, untaggedMarkers };
}

function* files(dir: string, suffix: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* files(p, suffix);
    else if (p.endsWith(suffix)) yield p;
  }
}

function scanTree(dir: string, suffix: string): Map<string, FileScan> {
  const out = new Map<string, FileScan>();
  for (const f of files(dir, suffix)) {
    const rel = relative(dir, f);
    if (rel === SELF) continue;
    const scan = scanSource(readFileSync(f, 'utf-8'));
    if (scan.unjustified.length || scan.untaggedMarkers.length) out.set(rel, scan);
  }
  return out;
}

const footer = `  rerun: ${RERUN}\n  docs: ${DOC}`;

function problemsFor(scans: Map<string, FileScan>, baseline: Record<string, number>, prefix = 'test/') {
  const fresh: string[] = [];
  const stale: string[] = [];
  const untagged: string[] = [];
  for (const [rel, scan] of scans) {
    for (const line of scan.untaggedMarkers) {
      untagged.push([
        `${RULE} (untagged marker): ${prefix}${rel}:${line}`,
        `  reason: every ${MARKER} marker must name one category so reviewers can see why a source read is legitimate.`,
        `  remedy: write it as // ${MARKER}[<category>]: <why>, with <category> one of ${MARKER_TAGS.join(', ')}.`,
        footer,
      ].join('\n'));
    }
    const expected = baseline[rel] ?? 0;
    if (scan.unjustified.length > expected) {
      fresh.push([
        `${RULE}: ${prefix}${rel}:${scan.unjustified.join(',')} reads src/ text without a tagged justification.`,
        `  count: expected at most ${expected} unjustified read site(s) in this file, found ${scan.unjustified.length}.`,
        `  reason: a source-text assertion pins spelling, not behavior.`,
        `  remedy: assert runtime behavior instead, or add // ${MARKER}[<category>]: <why> on the read or within the 3 lines above.`,
        footer,
      ].join('\n'));
    }
  }
  for (const [rel, expected] of Object.entries(baseline)) {
    const actual = scans.get(rel)?.unjustified.length ?? 0;
    if (actual >= expected) continue;
    stale.push([
      `${RULE} (stale ratchet entry): ${prefix}${rel} now has ${actual} unjustified read site(s); GRANDFATHERED records ${expected}.`,
      `  remedy: ${actual === 0 ? 'remove the entry' : `lower the entry to ${actual}`} in test/test-reads-source-smell.test.ts; do not add reads back.`,
      footer,
    ].join('\n'));
  }
  return { fresh, stale, untagged };
}

describe('#3665 — tests that read src/ text need a tagged justification', () => {
  const corpus = problemsFor(scanTree(TEST_DIR, '.test.ts'), GRANDFATHERED);

  test('every test-reads-source-ok marker carries a category tag', () => {
    expect(corpus.untagged, corpus.untagged.join('\n\n')).toEqual([]);
  });

  test('no new unjustified src/ read sites (per-file exact-count ratchet)', () => {
    expect(corpus.fresh, corpus.fresh.join('\n\n')).toEqual([]);
  });

  test('the ratchet only shrinks (stale counts must be lowered)', () => {
    expect(corpus.stale, corpus.stale.join('\n\n')).toEqual([]);
  });
});

describe('source-read detector fixtures', () => {
  const fixture = (name: string) => scanSource(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));

  test.each([
    ['same-line literal path', 'form-literal.fixture.ts', [5]],
    ['multi-line read call', 'form-multiline.fixture.ts', [5]],
    ["join(...) with a 'src' segment", 'form-join-segment.fixture.ts', [5]],
    ['Bun.file(...)', 'form-bun-file.fixture.ts', [4]],
    ['readFile and fs.promises.readFile', 'form-read-file.fixture.ts', [6, 7]],
    ['constant holding a src path, followed transitively', 'form-constant.fixture.ts', [7, 8]],
  ])('detects %s', (_label, name, lines) => {
    expect(fixture(name).unjustified).toEqual(lines);
  });

  test('a tagged marker justifies the read; non-src reads are not sites', () => {
    expect(fixture('tagged-ok.fixture.ts')).toEqual({ unjustified: [], untaggedMarkers: [] });
  });

  test('an untagged new read fails with the full diagnostic', () => {
    const scans = new Map([['untagged-new.fixture.ts', fixture('untagged-new.fixture.ts')]]);
    const { fresh, untagged } = problemsFor(scans, {}, '');
    expect(untagged).toHaveLength(1);
    expect(untagged[0]).toContain(`${RULE} (untagged marker): untagged-new.fixture.ts:4`);
    expect(untagged[0]).toContain(`remedy: write it as // ${MARKER}[<category>]: <why>`);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toContain(`${RULE}: untagged-new.fixture.ts:5 reads src/ text without a tagged justification.`);
    expect(fresh[0]).toContain('count: expected at most 0 unjustified read site(s) in this file, found 1.');
    expect(fresh[0]).toContain(`rerun: ${RERUN}`);
    expect(fresh[0]).toContain(`docs: ${DOC}`);
  });

  test('a new pin in a grandfathered file fails; a dropped count is stale', () => {
    const scans = new Map([['grandfathered.fixture.ts', fixture('grandfathered.fixture.ts')]]);
    const grown = problemsFor(scans, { 'grandfathered.fixture.ts': 1 }, '');
    expect(grown.fresh).toHaveLength(1);
    expect(grown.fresh[0]).toContain('count: expected at most 1 unjustified read site(s) in this file, found 2.');
    const shrunk = problemsFor(scans, { 'grandfathered.fixture.ts': 3 }, '');
    expect(shrunk.fresh).toEqual([]);
    expect(shrunk.stale).toHaveLength(1);
    expect(shrunk.stale[0]).toContain('(stale ratchet entry): grandfathered.fixture.ts now has 2 unjustified read site(s); GRANDFATHERED records 3.');
    expect(shrunk.stale[0]).toContain('remedy: lower the entry to 2 in test/test-reads-source-smell.test.ts; do not add reads back.');
  });
});

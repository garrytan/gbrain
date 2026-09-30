#!/usr/bin/env node
// check-test-placeholders.mjs — flags no-op placeholder assertions in tests.
//
// A test whose only assertion is `expect(true).toBe(true)` passes whatever the
// product does. This guard parses every test/**/*.test.ts file (excluding
// test/fixtures/**) with the TypeScript compiler API and visits CallExpression
// nodes, so text inside string and template literals is never matched. It
// flags exactly these no-op forms:
//
//   expect(true)                  (no matcher)
//   expect(true).toBe(true)
//   expect(true).toBeTruthy()
//   expect(1).toBe(1)
//
// `expect(true).toBe(false)` is a deliberate fail sentinel and is not flagged.
// This is a limited hygiene check: it does not detect low-value coverage in
// general (see docs/TESTING.md "Authoring gate").
//
// Allowlist entries are { path, test?, reason, count? } keyed by repo-relative
// path plus the enclosing test name ("describe > test"); `count` defaults to 1.
// A file or test with more sites than its entry fails as a new placeholder; an
// entry whose file or test is gone, or whose count is above the actual count,
// fails as stale.
//
// Self-test seam: argv[2] (or GBRAIN_GUARD_ROOT) points at a fixture tree with
// its own test/ directory; in fixture mode the allowlist is disabled and files
// named *.test.fixture.ts are scanned too (fixtures under the repo's test/ tree
// must not end in .test.ts, or the unit runner would execute them).
//
// Exit: 0 clean · 1 violations or stale allowlist entries · 2 infra error.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = process.argv[2] || process.env.GBRAIN_GUARD_ROOT || '.';
const fixtureMode = !!(process.argv[2] || process.env.GBRAIN_GUARD_ROOT);

const RULE = 'test-placeholder-assertion';
const RERUN = 'bun run check:test-placeholders';
const DOC = 'docs/TESTING.md#placeholder-assertions';

const ALLOWLIST = [
  {
    path: 'test/operation-context-sourceid-required.test.ts',
    test: 'OperationContext.sourceId — REQUIRED contract > omitting sourceId from an OperationContext literal is a type error',
    reason: 'the assertion is the @ts-expect-error line, enforced by bun run typecheck in verify',
  },
  {
    path: 'test/operation-context-sourceid-required.test.ts',
    test: 'OperationContext.sourceId — REQUIRED contract > passing undefined for sourceId is a type error',
    reason: 'the assertion is the @ts-expect-error line, enforced by bun run typecheck in verify',
  },
  {
    path: 'test/e2e/embedding-column-postgres.test.ts',
    test: 'postgres E2E — embedding column (skipped: DATABASE_URL unset) > skipped',
    reason: 'body of a describe.skip visibility marker for the unset-DATABASE_URL arm; never executes',
  },
  {
    path: 'test/e2e/upsert-chunks-registry-column.test.ts',
    test: '#1262 upsertChunks registry-aware writes (postgres — skipped: DATABASE_URL unset) > skipped',
    reason: 'body of a describe.skip visibility marker for the unset-DATABASE_URL arm; never executes',
  },
  {
    path: 'test/e2e/graph-signals-eval.test.ts',
    test: 'Gate 1 (QUALITY): no statistically significant regression in wrong direction',
    reason: 'the gate fails by throwing a diagnostic above this line; the marker records that it passed',
  },
  {
    path: 'test/e2e/sync-credential-preflight.test.ts',
    test: 'v0.41.6.0 D1 E2E — gbrain sync preflight rejects missing OPENAI_API_KEY > does NOT write 565 identical entries to sync-failures.jsonl',
    reason: 'an absent sync-failures.jsonl is the correct outcome; the other branch asserts the file contents',
  },
];

function walk(dir, pattern, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(p, pattern, out);
    } else if (pattern.test(p)) {
      out.push(p);
    }
  }
  return out;
}

function isLiteral(node, value) {
  if (value === true) return node.kind === ts.SyntaxKind.TrueKeyword;
  return ts.isNumericLiteral(node) && node.text === String(value);
}

function expectArg(node) {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'expect') return null;
  if (node.arguments.length !== 1) return null;
  const arg = node.arguments[0];
  if (isLiteral(arg, true)) return true;
  if (isLiteral(arg, 1)) return 1;
  return null;
}

function placeholderForm(call) {
  const subject = expectArg(call);
  if (subject === true) {
    const parent = call.parent;
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== call) return 'expect(true)';
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const inner = call.expression.expression;
  const matcher = call.expression.name.text;
  const innerSubject = expectArg(inner);
  if (innerSubject === true && matcher === 'toBe' && call.arguments.length === 1 && isLiteral(call.arguments[0], true)) {
    return 'expect(true).toBe(true)';
  }
  if (innerSubject === true && matcher === 'toBeTruthy' && call.arguments.length === 0) {
    return 'expect(true).toBeTruthy()';
  }
  if (innerSubject === 1 && matcher === 'toBe' && call.arguments.length === 1 && isLiteral(call.arguments[0], 1)) {
    return 'expect(1).toBe(1)';
  }
  return null;
}

const BLOCK_CALLEES = new Set(['describe', 'test', 'it', 'describeE2E', 'describeIf', 'testIf']);

function blockTitle(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  let callee = node.expression;
  if (ts.isCallExpression(callee)) callee = callee.expression;
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee) || !BLOCK_CALLEES.has(callee.text)) return null;
  const first = node.arguments[0];
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  if (ts.isTemplateExpression(first)) return first.getText().slice(1, -1);
  return null;
}

function scanFile(abs, rel) {
  const text = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites = [];
  const visit = (node, titles) => {
    let next = titles;
    if (ts.isCallExpression(node)) {
      const form = placeholderForm(node);
      if (form) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        sites.push({ path: rel, line: line + 1, form, test: titles.length ? titles.join(' > ') : '' });
      }
      const title = blockTitle(node);
      if (title !== null) next = [...titles, title];
    }
    ts.forEachChild(node, child => visit(child, next));
  };
  visit(sf, []);
  return sites;
}

export function scanTree(treeRoot, fixtures) {
  const testDir = join(treeRoot, 'test');
  if (!existsSync(testDir)) return null;
  const fixturesPrefix = join(testDir, 'fixtures') + sep;
  const pattern = fixtures ? /\.test(\.fixture)?\.ts$/ : /\.test\.ts$/;
  const files = walk(testDir, pattern).filter(p => !p.startsWith(fixturesPrefix));
  const sites = files.flatMap(abs => scanFile(abs, relative(treeRoot, abs).split(sep).join('/')));
  return { files, sites };
}

export function evaluate(sites, allowlist, treeRoot) {
  const keyOf = (path, test) => `${path}\u0000${test ?? ''}`;
  const byKey = new Map();
  for (const site of sites) {
    const key = keyOf(site.path, site.test);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(site);
  }
  const footer = `  rerun: ${RERUN}\n  docs: ${DOC}`;
  const problems = [];
  const allowed = new Map(allowlist.map(e => [keyOf(e.path, e.test), e]));
  for (const [key, group] of byKey) {
    const entry = allowed.get(key);
    const expected = entry ? (entry.count ?? 1) : 0;
    if (group.length <= expected) continue;
    for (const site of group) {
      problems.push([
        `${RULE}: ${site.path}:${site.line} uses \`${site.form}\`${site.test ? ` in "${site.test}"` : ''}.`,
        `  reason: this assertion passes whatever the product does, so the test protects no behavior.`,
        `  count: ${entry ? 'allowlist expects' : 'expected'} ${expected} placeholder(s) for this test, found ${group.length}.`,
        `  remedy: assert the observable outcome, delete the test if it has no contract, or add a reasoned allowlist entry in scripts/check-test-placeholders.mjs.`,
        footer,
      ].join('\n'));
    }
  }
  for (const entry of allowlist) {
    const actual = (byKey.get(keyOf(entry.path, entry.test)) ?? []).length;
    const expected = entry.count ?? 1;
    if (actual >= expected) continue;
    const why = !existsSync(join(treeRoot, entry.path)) ? 'its file no longer exists'
      : actual === 0 ? 'no placeholder remains for this test'
      : 'the placeholder count dropped';
    problems.push([
      `${RULE} (stale allowlist entry): ${entry.path}${entry.test ? ` "${entry.test}"` : ''}: ${why}.`,
      `  count: allowlist expects ${expected}, found ${actual}.`,
      `  remedy: remove the entry or reduce its count in scripts/check-test-placeholders.mjs; do not restore the placeholder.`,
      footer,
    ].join('\n'));
  }
  return { problems, allowedSites: sites.length };
}

function main() {
  const scan = scanTree(root, fixtureMode);
  if (!scan) {
    console.error(`check-test-placeholders: no test/ under ${root}`);
    process.exit(2);
  }
  const { problems, allowedSites } = evaluate(scan.sites, fixtureMode ? [] : ALLOWLIST, root);
  if (problems.length > 0) {
    console.error(problems.join('\n\n'));
    console.error(`\ncheck-test-placeholders: ${problems.length} problem(s). Rerun: ${RERUN}. See ${DOC}`);
    process.exit(1);
  }
  console.log(`check-test-placeholders: OK (${scan.files.length} test files, ${allowedSites} allowlisted placeholder site(s))`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

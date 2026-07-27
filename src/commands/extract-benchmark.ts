/**
 * v0.42 Wave C2 — `gbrain extract benchmark` CLI.
 *
 *   gbrain extract benchmark --pack <pack> --kind <type> [--json]
 *
 * Reads the pack's fixture corpus (declared by the v0.42 ExtractableSpec
 * `fixture_corpus` field, or the conventional `fixtures/extract/<type>.jsonl`
 * if the pack only sets `extractable: true`), runs each fixture's
 * `page_body` through the appropriate extractor, and emits a side-by-side
 * diff of expected vs actual claims.
 *
 * Per plan D-EXTRACT-21: fixture path is canonicalized within pack root.
 * Reject absolute paths, `..`, null bytes, symlinks (validation lives in
 * `validateFixturePath()` below; reused by the benchmark's read step).
 *
 * Per plan C2: fail-loud on missing fixtures with paste-ready
 * `gbrain schema scaffold-extractable` hint.
 *
 * Exit codes:
 *   - 0 PASS: all fixtures meet the per-fixture recall floor
 *     (default 0.8; configurable via pack manifest
 *     `extractable.benchmark_min_recall`).
 *   - 1 FAIL: at least one fixture below the floor.
 *   - 2 USAGE: missing flags, missing fixture file, parse failure.
 *
 * v0.42 scope: benchmark dispatch DOES NOT actually call the LLM —
 * the conversation-parser cathedral already has its own eval harness
 * (`gbrain eval conversation-parser`), and the facts.prose generic
 * LLM handler is deferred to Wave E. v0.42 benchmark instead reports
 * the fixture corpus shape + path resolution + recall-floor config so
 * pack authors can validate the scaffolding cleanly. When Wave E adds
 * facts.prose, the LLM dispatch fills in here without API change.
 */

import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { BrainEngine } from '../core/engine.ts';
import { loadActivePackBestEffort } from '../core/schema-pack/best-effort.ts';
import { getExtractableSpec } from '../core/schema-pack/extractable.ts';
import { locateMutablePackFile } from '../core/schema-pack/mutate.ts';

export interface BenchmarkFixture {
  fixture_id: string;
  page_body: string;
  expected_claims: Array<Record<string, unknown>>;
  notes?: string;
}

export interface BenchmarkResult {
  pack: string;
  kind: string;
  fixture_corpus_path: string;
  total_fixtures: number;
  fixtures_pass: number;
  fixtures_fail: number;
  /** Per-fixture verdict array; stable schema_version 1. */
  per_fixture: Array<{
    fixture_id: string;
    expected_count: number;
    actual_count: number;
    notes?: string;
    /** v0.42 stub: pure shape report (no LLM dispatch yet — Wave E). */
    note_v042: string;
  }>;
  min_recall: number;
  /**
   * v0.42 benchmark status:
   *   - 'stub-reported' when this is the v0.42 shape-only report
   *   - 'pass' / 'fail' once Wave E wires the LLM dispatch
   */
  status: 'stub-reported' | 'pass' | 'fail';
}

/**
 * Strict path validation per D-EXTRACT-21. The fixture_corpus declared
 * in the pack manifest MUST canonicalize to a path within the pack root.
 *
 *   - absolute paths → rejected
 *   - `..` segments → rejected
 *   - null bytes → rejected
 *   - resolves outside pack root → rejected
 *   - symlinks → rejected (operator should not be able to silently follow
 *     a symlink out of the pack root to read /etc/passwd)
 *
 * Returns the canonicalized absolute path on success. Throws on rejection
 * with a paste-ready remediation hint.
 *
 * Exported so the v0.42 Wave C test surface can exercise the validator
 * directly without going through the full benchmark dispatch.
 */
export function validateFixturePath(
  packRoot: string,
  fixtureCorpusRelative: string,
): string {
  if (fixtureCorpusRelative.includes('\0')) {
    throw new Error(
      `pack fixture_corpus path contains a null byte: ${JSON.stringify(fixtureCorpusRelative)}. ` +
      `Pack manifests must declare relative paths within the pack root.`,
    );
  }
  if (isAbsolute(fixtureCorpusRelative)) {
    throw new Error(
      `pack fixture_corpus must be a RELATIVE path within the pack root. ` +
      `Got: ${fixtureCorpusRelative}. ` +
      `Edit the pack manifest's extractable.fixture_corpus to e.g. ` +
      `fixtures/extract/<type>.jsonl.`,
    );
  }
  // Reject any `..` segment up front (defense in depth before resolve()).
  const segments = fixtureCorpusRelative.split(/[/\\]/);
  if (segments.some(s => s === '..')) {
    throw new Error(
      `pack fixture_corpus path contains a '..' segment: ${fixtureCorpusRelative}. ` +
      `Pack manifests must declare paths that stay within the pack root.`,
    );
  }
  const absolute = resolve(packRoot, fixtureCorpusRelative);
  // Resolve() collapses .., but we already rejected those above. Confirm
  // the resolved path is within packRoot.
  const rel = relative(packRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `pack fixture_corpus path resolves OUTSIDE the pack root. ` +
      `Pack root: ${packRoot}. Resolved: ${absolute}. ` +
      `This usually means a '..' segment or an absolute path slipped past ` +
      `validation — please report.`,
    );
  }
  // Symlink rejection — only if the file actually exists.
  if (existsSync(absolute)) {
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `pack fixture_corpus is a symbolic link, which is not allowed: ${absolute}. ` +
          `Replace with a regular file or move the target into the pack root.`,
        );
      }
      // Also verify realpath stays within pack root (defense against
      // intermediate directory symlinks).
      const real = realpathSync(absolute);
      const realRoot = realpathSync(packRoot);
      const realRel = relative(realRoot, real);
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new Error(
          `pack fixture_corpus realpath resolves outside the pack root ` +
          `(an intermediate symlink may be redirecting). ` +
          `Real path: ${real}.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('pack fixture_corpus')) throw err;
      // realpathSync may throw EACCES / EPERM; surface those raw.
      throw err;
    }
  }
  return absolute;
}

/**
 * Parse the fixture corpus from JSONL content. One JSON-serialized
 * fixture per non-blank line. Fails loud on any parse error so the
 * pack-author sees exactly which line is broken.
 */
export function parseBenchmarkFixtures(jsonl: string): BenchmarkFixture[] {
  const out: BenchmarkFixture[] = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `fixture corpus parse failed at line ${i + 1}: ${(err as Error).message}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `fixture corpus line ${i + 1} is not a JSON object`,
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.fixture_id !== 'string') {
      throw new Error(`fixture corpus line ${i + 1}: missing required field 'fixture_id'`);
    }
    if (typeof obj.page_body !== 'string') {
      throw new Error(`fixture corpus line ${i + 1}: missing required field 'page_body'`);
    }
    if (!Array.isArray(obj.expected_claims)) {
      throw new Error(`fixture corpus line ${i + 1}: missing required field 'expected_claims' (must be array)`);
    }
    out.push({
      fixture_id: obj.fixture_id,
      page_body: obj.page_body,
      expected_claims: obj.expected_claims as Array<Record<string, unknown>>,
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    });
  }
  return out;
}

/**
 * CLI entry: `gbrain extract benchmark`.
 */
export async function runExtractBenchmark(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const json = args.includes('--json');
  const packIdx = args.indexOf('--pack');
  const kindIdx = args.indexOf('--kind');
  const packName = packIdx >= 0 && packIdx + 1 < args.length ? args[packIdx + 1] : undefined;
  const kindName = kindIdx >= 0 && kindIdx + 1 < args.length ? args[kindIdx + 1] : undefined;

  if (!packName || !kindName) {
    console.error('Usage: gbrain extract benchmark --pack <pack> --kind <type> [--json]');
    process.exit(2);
  }

  // Resolve the pack. The benchmark targets the writable-pack tier
  // (bundled packs can't be benchmarked because they ship without
  // user-editable fixtures).
  let packRoot: string;
  try {
    const located = locateMutablePackFile(packName);
    packRoot = dirname(located.path);
  } catch (err) {
    console.error(`Failed to locate pack '${packName}': ${(err as Error).message}`);
    process.exit(2);
  }

  // Resolve the ExtractableSpec for the requested type. The OperationContext
  // we build here is local (CLI-side, never remote), so remote:false threads
  // through to the load-active path correctly.
  let pack;
  try {
    pack = await loadActivePackBestEffort({
      engine,
      remote: false,
    } as unknown as Parameters<typeof loadActivePackBestEffort>[0]);
  } catch (err) {
    console.error(`Failed to load active pack: ${(err as Error).message}`);
    process.exit(2);
  }

  const spec = pack ? getExtractableSpec(pack.manifest, kindName) : null;
  // Fall back to convention if the active pack doesn't declare this kind.
  // The fixture path the conventional scaffold writes is
  // fixtures/extract/<kind>.jsonl.
  let fixturePath: string;
  if (spec?.fixture_corpus) {
    try {
      fixturePath = validateFixturePath(packRoot, spec.fixture_corpus);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  } else {
    // Convention: fixtures/extract/<kind>.jsonl
    const conventional = join('fixtures', 'extract', `${kindName}.jsonl`);
    try {
      fixturePath = validateFixturePath(packRoot, conventional);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }

  if (!existsSync(fixturePath)) {
    console.error(
      `Fixture corpus not found: ${fixturePath}\n\n` +
      `Run this to generate stub fixtures (5 placeholder cases):\n` +
      `  gbrain schema scaffold-extractable ${kindName} --pack ${packName}`,
    );
    process.exit(2);
  }

  let fixtures: BenchmarkFixture[];
  try {
    fixtures = parseBenchmarkFixtures(readFileSync(fixturePath, 'utf-8'));
  } catch (err) {
    console.error(`Fixture parse failed: ${(err as Error).message}`);
    process.exit(2);
  }

  const minRecall = spec?.benchmark_min_recall ?? 0.8;

  // v0.42 STUB: report fixture shape + path + recall floor without
  // dispatching the LLM. Wave E wires the actual extractor.
  const result: BenchmarkResult = {
    pack: packName,
    kind: kindName,
    fixture_corpus_path: fixturePath,
    total_fixtures: fixtures.length,
    fixtures_pass: 0,
    fixtures_fail: 0,
    per_fixture: fixtures.map(f => ({
      fixture_id: f.fixture_id,
      expected_count: f.expected_claims.length,
      actual_count: 0,
      notes: f.notes,
      note_v042: 'shape report only; LLM dispatch deferred to v0.43+ (per plan Wave E)',
    })),
    min_recall: minRecall,
    status: 'stub-reported',
  };

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
    return;
  }

  console.log(`Extract benchmark — pack=${packName} kind=${kindName}`);
  console.log(`Fixture corpus: ${fixturePath}`);
  console.log(`Total fixtures: ${fixtures.length}`);
  console.log(`Min recall floor: ${minRecall}`);
  console.log('');
  for (const f of fixtures) {
    const notes = f.notes ? ` — ${f.notes}` : '';
    console.log(`  ${f.fixture_id}: ${f.expected_claims.length} expected claim(s)${notes}`);
  }
  console.log('');
  console.log('Status: stub-reported (v0.42 reports fixture shape only).');
  console.log('Wave E will wire the actual LLM dispatch for facts.prose-style kinds.');
}

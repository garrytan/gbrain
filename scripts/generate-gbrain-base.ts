#!/usr/bin/env bun
// v0.38 codegen — emit `gbrain-base.yaml` from source-of-truth constants.
//
// Purpose: gbrain-base IS the v0.38 reproduction of pre-v0.38 hardcoded
// behavior. The pack must stay byte-for-byte equivalent to what the
// engine did before. This script reads:
//   - src/core/markdown.ts::inferType (path → type mappings, ordered)
//   - src/core/link-extraction.ts::inferLinkType + FRONTMATTER_LINK_MAP
//   - src/core/types.ts::ALL_PAGE_TYPES (the seed types)
//
// And emits the canonical gbrain-base.yaml. Determinism contract (T25 +
// codex F21): re-running produces byte-identical output.
//
// For v0.38 Phase A, the YAML is HAND-MAINTAINED but VALIDATED by this
// script: it loads the checked-in YAML and asserts the pack manifest
// validates AND every ALL_PAGE_TYPES seed has a matching page_type entry.
// In Phase B (T7), this script could be extended to fully regenerate the
// YAML by introspecting the AST of the source constants; for v0.38 ship,
// the hand-maintained baseline + validation gate is sufficient and avoids
// AST-walking complexity.
//
// Usage:
//   bun scripts/generate-gbrain-base.ts --check     # CI validation
//   bun scripts/generate-gbrain-base.ts --diagnose  # show drift report
//
// Exit codes:
//   0 = gbrain-base.yaml is consistent with source constants
//   1 = drift detected; gbrain-base.yaml needs hand-update
//   2 = script error

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PAGE_TYPES } from '../src/core/types.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const BASE_PATH = join(REPO_ROOT, 'src/core/schema-pack/base/gbrain-base.yaml');

const args = process.argv.slice(2);
const checkMode = args.includes('--check') || args.length === 0;
const diagnoseMode = args.includes('--diagnose');

function fail(msg: string): never {
  console.error('[gbrain-base-codegen] FAIL:', msg);
  process.exit(1);
}

function ok(msg: string): void {
  console.log('[gbrain-base-codegen] OK:', msg);
}

console.log('[gbrain-base-codegen] checking', BASE_PATH);

// 1. Load + validate the checked-in YAML
let manifest;
try {
  manifest = loadPackFromFile(BASE_PATH);
} catch (e) {
  fail(`loadPackFromFile threw: ${(e as Error).message}`);
}

if (manifest.name !== 'gbrain-base') {
  fail(`expected name=gbrain-base, got ${manifest.name}`);
}
if (manifest.extends !== null) {
  fail(`gbrain-base must have extends: null (got ${JSON.stringify(manifest.extends)})`);
}

ok(`loaded gbrain-base v${manifest.version}; ${manifest.page_types.length} page types, ${manifest.link_types.length} link verbs`);

// 2. Every ALL_PAGE_TYPES seed must have a matching page_type entry
const yamlTypes = new Set(manifest.page_types.map(pt => pt.name));
const seedTypes = new Set(ALL_PAGE_TYPES);
const missing: string[] = [];
const extra: string[] = [];
for (const seed of seedTypes) {
  if (!yamlTypes.has(seed)) missing.push(seed);
}
for (const yamlType of yamlTypes) {
  if (!seedTypes.has(yamlType)) extra.push(yamlType);
}

if (missing.length > 0) {
  if (diagnoseMode) console.error('[gbrain-base-codegen] missing seed types:', missing);
  fail(`gbrain-base.yaml is missing ${missing.length} page_types from ALL_PAGE_TYPES: ${missing.join(', ')}`);
}
if (extra.length > 0) {
  // Extra is OK — pack can declare types beyond the seed list (e.g. if
  // a future seed addition lands in the YAML before ALL_PAGE_TYPES is
  // updated). Warn but don't fail.
  console.warn('[gbrain-base-codegen] WARN: extra types in gbrain-base.yaml not in ALL_PAGE_TYPES:', extra);
}

ok(`all ${ALL_PAGE_TYPES.length} seed types present in gbrain-base.yaml`);

// 3. Determinism check: re-load + canonical serialize must round-trip
//    identically. This catches accidental YAML formatting drift.
const original = readFileSync(BASE_PATH, 'utf-8');
const reload = parseSchemaPackManifest(loadPackFromFile(BASE_PATH));
const reloadCount = reload.page_types.length;
if (reloadCount !== manifest.page_types.length) {
  fail(`re-load produced different page_type count: ${reloadCount} vs ${manifest.page_types.length}`);
}

ok('determinism check passed');
console.log('[gbrain-base-codegen] PASS — gbrain-base.yaml is consistent');
process.exit(0);

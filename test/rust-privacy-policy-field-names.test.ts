/**
 * The keys the TypeScript fact and page policy sends the Rust store are the fields of the store's `PrivacyPolicy`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every key of `StorePrivacyPolicy` (src/core/rust-engine/store-members/private-provenance.ts), and of its nested
 *    `labelledOnly` and `folderCoverage` objects, names a field of the Rust structs `PrivacyPolicy`, `LabelledOnly` and
 *    `FolderCoverage` (rust/crates/gbrain-store/src/facts/privacy.rs), after the struct's serde rename rule (`camelCase` for the
 *    first two, none for the last). The structs use `deny_unknown_fields`, so a key the store does not know is rejected on every read
 *    that sends it.
 *  - Regression: row 32e-b-4 sent `lineageProvenance` while the store's field is `provenanceLineage`; the Rust unit tests build the
 *    policy in Rust, so only the integration test caught it, after a cargo run. This test fails at unit time, with no cargo.
 *  - Why existing coverage misses it: the parity cases reach the store only on the Rust arm (opt-in), and no test compared the two
 *    spellings.
 *  - Seam: none. Both files are read as text; the self-test mutates one spelling and expects the check to fail.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const TS_FILE = 'src/core/rust-engine/store-members/private-provenance.ts';
const RUST_FILE = 'rust/crates/gbrain-store/src/facts/privacy.rs';

const camel = (snake: string): string => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The text between `start` and the first line that is exactly `end`. */
function block(text: string, start: RegExp, end: string): string {
  const open = start.exec(text);
  if (!open) throw new Error(`no block starts with ${start}`);
  const from = open.index + open[0].length;
  const stop = text.indexOf(`\n${end}`, from);
  if (stop < 0) throw new Error(`block ${start} has no closing ${JSON.stringify(end)}`);
  return text.slice(from, stop);
}

/** The wire names of the `pub` fields of a Rust struct, after its serde rename rule. */
function rustFields(rust: string, struct: string, rename: 'camelCase' | 'none'): string[] {
  const body = block(rust, new RegExp(`pub struct ${struct} \\{\\n`), '}');
  const names = [...body.matchAll(/^ {4}pub ([a-z0-9_]+):/gm)].map(m => m[1]!);
  if (names.length === 0) throw new Error(`no fields found in ${struct}`);
  // The struct must say how it reads names, and must refuse unknown ones: the check below is only a proof under both.
  const attribute = rust.slice(Math.max(0, rust.indexOf(`pub struct ${struct} {`) - 200), rust.indexOf(`pub struct ${struct} {`));
  expect({ struct, deny: attribute.includes('deny_unknown_fields') }).toEqual({ struct, deny: true });
  expect({ struct, camel: attribute.includes('rename_all = "camelCase"') }).toEqual({ struct, camel: rename === 'camelCase' });
  return names.map(n => (rename === 'camelCase' ? camel(n) : n));
}

/** The keys an object type literal names, `{ a: string; b?: number }`. */
const literalKeys = (literal: string): string[] => [...literal.matchAll(/(?:^|[{;,]\s*)([A-Za-z_][A-Za-z0-9_]*)\??:/g)].map(m => m[1]!);

/** Every wire key the TypeScript policy can send, by object: the policy itself and its two nested objects. */
function tsKeys(ts: string): { policy: string[]; labelledOnly: string[]; folderCoverage: string[] } {
  const body = block(ts, /export interface StorePrivacyPolicy \{\n/, '}');
  const policy = [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(m => m[1]!);
  const nested = (key: string): string[] => {
    const line = new RegExp(`^ {2}${key}\\?: (\\{[^\\n]*\\})`, 'm').exec(body);
    if (!line) throw new Error(`no inline object type for ${key}`);
    return literalKeys(line[1]!);
  };
  return { policy, labelledOnly: nested('labelledOnly'), folderCoverage: nested('folderCoverage') };
}

/** What differs: each TypeScript key the Rust struct does not name. Empty when the spellings agree. */
function unknownToRust(ts: string, rust: string): Record<string, string[]> {
  const sent = tsKeys(ts);
  const known = {
    policy: rustFields(rust, 'PrivacyPolicy', 'camelCase'),
    labelledOnly: rustFields(rust, 'LabelledOnly', 'camelCase'),
    folderCoverage: rustFields(rust, 'FolderCoverage', 'none'),
  };
  const out: Record<string, string[]> = {};
  for (const object of ['policy', 'labelledOnly', 'folderCoverage'] as const) {
    const unknown = sent[object].filter(key => !known[object].includes(key));
    if (unknown.length) out[object] = unknown;
  }
  return out;
}

const ts = readFileSync(join(root, TS_FILE), 'utf8');
const rust = readFileSync(join(root, RUST_FILE), 'utf8');

describe('the policy keys the TypeScript member sends the Rust store', () => {
  test('every key of StorePrivacyPolicy, labelledOnly and folderCoverage is a field of the store struct (deny_unknown_fields)', () => {
    expect(unknownToRust(ts, rust)).toEqual({});
  });

  test('the parsers find the fields they compare (a parse that finds none would pass for nothing)', () => {
    const sent = tsKeys(ts);
    expect(sent.policy).toEqual(expect.arrayContaining(['honorAliases', 'entityPrivacy', 'ownerOnly', 'labelledOnly', 'folderCoverage', 'provenanceLineage']));
    expect(sent.labelledOnly).toEqual(['identity', 'satisfiedRuleIds', 'lineage', 'member']);
    expect(sent.folderCoverage).toEqual(['source_id', 'prefix']);
    expect(rustFields(rust, 'PrivacyPolicy', 'camelCase')).toEqual(expect.arrayContaining(['honorAliases', 'entityPrivacy', 'ownerOnly', 'labelledOnly', 'folderCoverage', 'provenanceLineage']));
  });

  test('a misspelled key is caught: the spelling that row 32e-b-4 first sent, a snake_case key, and a key the store lacks', () => {
    expect(unknownToRust(ts.replace('provenanceLineage?:', 'lineageProvenance?:'), rust)).toEqual({ policy: ['lineageProvenance'] });
    expect(unknownToRust(ts.replace('satisfiedRuleIds: string[]; lineage?', 'satisfied_rule_ids: string[]; lineage?'), rust)).toEqual({ labelledOnly: ['satisfied_rule_ids'] });
    expect(unknownToRust(ts, rust.replace('pub provenance_lineage:', 'pub provenance_lineages:'))).toEqual({ policy: ['provenanceLineage'] });
  });
});

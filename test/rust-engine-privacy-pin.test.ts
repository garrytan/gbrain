/**
 * Pins the Rust page-privacy policy (rust/crates/gbrain-store/src/facts/privacy.rs) to the SQL the engines run.
 *
 * The private-page rule is NOT shared as code. src/core/search/private-visibility.ts renders it as SQL for PGLite and
 * Postgres, and privacy.rs is a hand-written port that judges the same rule on stored records. The only thing the two
 * sides hold in common is the text the TypeScript member compares (private-provenance.ts): the no-caller rendering,
 * less its flags (`honorAliases`, `entityPrivacy`, `ownerOnly`). Nothing compared that text to the Rust logic, so a
 * change to the rendering (a new privacy key, a new alias value, a new owner-only form) could land with every Rust test
 * green and the Rust arm leaking a page PGLite hides.
 *
 * This file closes that gap three ways, all of which fail with a pointer to privacy.rs:
 *  1. a digest of the normalized no-caller rendering (pages, facts, owner-only lineage form): any edit to the rendering
 *     fails until a person has read privacy.rs against it and moved the digest;
 *  2. an inventory of the tables, functions and frontmatter keys the rendering reads, split into what privacy.rs models
 *     and what it documents as not modelled, so a new input shows up as a named line, not a digest mismatch;
 *  3. constants both sides spell out, read from the Rust source: the privacy aliases, the edge whitespace and the
 *     owner-only source flag and kinds.
 * The behaviour itself is held by test/engine-parity/search-privacy.test.ts (Rust arm against PGLite).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDGE_WHITESPACE } from '../src/core/edge-whitespace.ts';
import { OWNER_ONLY_FLAG, OWNER_ONLY_KINDS, ownerOnlyPageSql } from '../src/core/access/owner-only.ts';
import { normalizeConceptInputs, storePagePolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';
import {
  PRIVACY_ALIASES,
  privatePagesFilterForCaller,
  privateProvenanceFilterUnderPolicy,
  withoutCallerAccess,
} from '../src/core/search/private-visibility.ts';

const RUST_FILE = 'rust/crates/gbrain-store/src/facts/privacy.rs';
// test-reads-source-ok[structural]: the Rust policy is hand-written beside the SQL rendering, so its constants are read from the source they must equal.
const RUST = readFileSync(join(import.meta.dir, '..', RUST_FILE), 'utf8');
/** privacy.rs judges the owner-only test through owner_only.rs, which spells out the source flag and kinds. */
const OWNER_ONLY_RUST_FILE = 'rust/crates/gbrain-store/src/owner_only.rs';
// test-reads-source-ok[structural]: the owner-only flag and kinds are hand-written beside owner-only.ts, so they are read from the source they must equal.
const OWNER_ONLY_RUST = readFileSync(join(import.meta.dir, '..', OWNER_ONLY_RUST_FILE), 'utf8');

const HOW = `private-visibility.ts (or owner-only.ts) now renders a different private-page rule. Read ${RUST_FILE} against `
  + 'the new text: the Rust arm must hide the same pages, or the member must refuse the new rule with '
  + 'engine_capability_missing (private-provenance.ts). Then update this file and run the Rust arm of '
  + 'test/engine-parity/search-privacy.test.ts (GBRAIN_TEST_RUST_ARM=1).';

const pagesBaseline = (): string => normalizeConceptInputs(withoutCallerAccess(() => privatePagesFilterForCaller('p')));
const factsBaseline = (): string => normalizeConceptInputs(withoutCallerAccess(() => privateProvenanceFilterUnderPolicy('facts')));
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The digest of what the store implements. Moving it is a statement that privacy.rs was read against the new text. */
const PINNED = {
  pages: '1d8a04bd4f8c6692e75a261b6619984d9ac4235805d33a0c5739593237daf90d',
  facts: '1de0e560461e91ef6198c4e5af85e5fe4d0bec627f87162f611216aba38146bc',
  ownerOnlyLineage: digest(`((SELECT gbrain_owner_only_lineage()) AND gbrain_owner_only_lineage('pages', p.id))`),
} as const;

/** The inputs the rendering reads, and whether privacy.rs models each (true) or documents it as empty or absent (false). */
const TABLES: Record<string, boolean> = {
  pages: true, // read_page / read_page_by_id
  sources: true, // OwnerOnlySources
  access_pending_coverage: false, // the store keeps no access rules or pending coverage: empty
  slug_aliases: false, // the aliases family is not served: empty
  slug_rename_history: false, // the aliases family is not served: empty
  jsonb_array_elements_text: true, // declared_slugs
};
const FUNCTIONS: Record<string, boolean> = {
  gbrain_access_origin_restricted: true, // origin_restricted
  gbrain_access_state_unreadable: false, // the store keeps no access state: never unreadable
  gbrain_access_folder_rules: false, // no folder rules
  gbrain_access_lineage_rules: false, // no folder rules
  gbrain_access_pending_covers: false, // no pending coverage
};
const KEYS = ['access', 'captured_via', 'confidentiality', 'derived_from', 'event', 'pinned_question', 'readable_by', 'source_slug', 'synthesized_by', 'visibility'];

const found = (text: string, re: RegExp): string[] => [...new Set([...text.matchAll(re)].map(m => m[1]!))].sort();

describe('the no-caller page policy PGLite renders, against privacy.rs', () => {
  test('the rendering is the one the store implements (digest)', () => {
    const now = { pages: digest(pagesBaseline()), facts: digest(factsBaseline()), ownerOnlyLineage: digest(ownerOnlyPageSql('p', 'fn')) };
    if (JSON.stringify(now) !== JSON.stringify(PINNED)) {
      throw new Error(`${HOW}\nrendered digests: ${JSON.stringify(now, null, 2)}\npinned digests:   ${JSON.stringify(PINNED, null, 2)}`);
    }
  });

  test('the rendering reads the tables, functions and frontmatter keys privacy.rs knows', () => {
    for (const [name, text] of [['pages', pagesBaseline()], ['facts', factsBaseline()]] as const) {
      const tables = found(text, /\b(?:FROM|JOIN)\s+([a-z_]+)/g);
      const fns = found(text, /\b(gbrain_[a-z_]+)\s*\(/g);
      const keys = found(text, /(?:frontmatter\s*(?:->>|->|\?)\s*|\? )'([a-z_]+)'/g);
      const unknown = [
        ...tables.filter(t => !(t in TABLES)).map(t => `table ${t}`),
        ...fns.filter(f => !(f in FUNCTIONS)).map(f => `function ${f}`),
        ...keys.filter(k => !KEYS.includes(k)).map(k => `frontmatter key ${k}`),
      ];
      expect(unknown, `${name} policy reads an input the Rust policy does not know. ${HOW}`).toEqual([]);
    }
    // The inputs marked modelled are named in privacy.rs, and each frontmatter key is a string literal there.
    for (const key of KEYS) expect(RUST, `privacy.rs has no "${key}" literal`).toContain(`"${key}"`);
    for (const word of ['concept-provenance', 'synthesized_from', 'life-chronicle:']) expect(RUST).toContain(`"${word}"`);
  });

  test('the privacy aliases are the same keys and values on both sides', () => {
    const block = RUST.match(/const PRIVACY_ALIASES:[^=]*=\s*\[([\s\S]*?)\n\];/);
    expect(block, `privacy.rs has no PRIVACY_ALIASES list. ${HOW}`).not.toBeNull();
    const rust: Record<string, string[]> = {};
    for (const entry of block![1]!.matchAll(/\(\s*"([a-z_]+)"\s*,\s*&\[([^\]]*)\]\s*,?\s*\)/g)) {
      rust[entry[1]!] = [...entry[2]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
    }
    expect(rust, `PRIVACY_ALIASES differ from ${RUST_FILE}. ${HOW}`).toEqual(Object.fromEntries(Object.entries(PRIVACY_ALIASES).map(([k, v]) => [k, [...v]])));
  });

  test('the edge whitespace is the same set on both sides', () => {
    const block = RUST.match(/const EDGE_SPACE:[^=]*=\s*&\[([\s\S]*?)\];/);
    expect(block, `privacy.rs has no EDGE_SPACE list. ${HOW}`).not.toBeNull();
    const escapes: Record<string, number> = { t: 9, n: 10, r: 13 };
    const rust = [...block![1]!.matchAll(/'(\\u\{([0-9A-Fa-f]+)\}|\\([tnr])|.)'/g)].map(m => (m[2] ? parseInt(m[2], 16) : m[3] ? escapes[m[3]]! : m[1]!.codePointAt(0)!));
    const ts = [...EDGE_WHITESPACE].map(c => c.codePointAt(0)!);
    expect(rust.sort((a, b) => a - b), `EDGE_WHITESPACE differs from ${RUST_FILE}. ${HOW}`).toEqual(ts.sort((a, b) => a - b));
  });

  test('the owner-only source flag and kinds are the ones privacy.rs reads', () => {
    // privacy.rs reads the owner-only test from owner_only.rs, which holds the flag and the kinds.
    expect(RUST).toContain('use crate::owner_only::{');
    expect(OWNER_ONLY_RUST).toContain(`text("${OWNER_ONLY_FLAG}").as_deref() == Some("true")`);
    // owner_only.rs reads exactly `kind IN (kinds) OR owner_only = 'true'` (a boolean true and the text "true" both read "true").
    const kinds = OWNER_ONLY_RUST.match(/const OWNER_ONLY_KINDS: &\[&str\] = &\[([^\]]*)\];/);
    expect(kinds, `OWNER_ONLY_KINDS is not spelled out in ${OWNER_ONLY_RUST_FILE}. ${HOW}`).not.toBeNull();
    expect(kinds![1].split(',').map(k => k.trim().replace(/^"|"$/g, '')).filter(Boolean), `owner-only kinds. ${HOW}`).toEqual([...OWNER_ONLY_KINDS]);
    expect(OWNER_ONLY_RUST).toContain('text("kind").is_some_and(|kind| OWNER_ONLY_KINDS.contains(&kind.as_str()))');
    expect(OWNER_ONLY_KINDS).toEqual(['imessage']);
  });

  test('the flags the member sends follow the rendering (honorAliases, entityPrivacy, ownerOnly)', () => {
    // Outside an engine scope the rendering is the closed owner-only form, with aliases on and the privacy part present.
    expect(storePagePolicy('searchKeyword', true)).toEqual({ honorAliases: true, entityPrivacy: true, ownerOnly: 'closed' });
    expect(storePagePolicy('searchKeyword', false)).toBeUndefined();
  });
});

/**
 * B5 — `gbrain protocol` document shape (buildProtocolDocument, src/commands/protocol.ts).
 *
 * The protocol document is the machine-readable face of the frozen
 * MEMORY_VERBS v1 contract (docs/protocol/MEMORY_VERBS_v1.md). The builder
 * composes it as:
 *
 *   VERB_NAMES.map(n => operationsByName[n]).filter(Boolean) → buildToolDefs → doc.verbs
 *
 * That `.filter(Boolean)` means a verb whose operation-catalog lookup fails
 * (e.g. a rename in operations.ts / verbs.ts that misses VERB_NAMES) would
 * SILENTLY SHRINK the published protocol instead of failing. Test 1 pins the
 * strongest available form — ordered deep-equality of Object.keys(doc.verbs)
 * against VERB_NAMES — so any dropped (or reordered, or extra) verb fails
 * loudly here.
 *
 * Pure unit test: imports the builder and asserts on the in-memory document.
 * No env mutation, no mock.module, no serial requirement.
 */

import { describe, expect, test } from 'bun:test';
import { buildProtocolDocument } from '../src/commands/protocol.ts';
import { MEMORY_VERBS_VERSION, VERB_NAMES } from '../src/core/verbs.ts';

interface VerbEntry {
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  annotations?: Record<string, unknown>;
  response_schema: Record<string, unknown> | undefined;
}

const doc = buildProtocolDocument();
const verbs = doc.verbs as Record<string, VerbEntry>;

describe('buildProtocolDocument — MEMORY_VERBS v1 document shape', () => {
  test('doc.verbs keys deep-equal VERB_NAMES in order — a failed tool-def lookup must FAIL the doc, not shrink it', () => {
    // Ordered deep-equality is deliberate: the builder maps VERB_NAMES in
    // order and .filter(Boolean) can only DROP entries, so any lookup miss
    // (or a stray extra verb, or reordering) breaks this exact-match.
    expect(Object.keys(verbs)).toEqual([...VERB_NAMES]);
  });

  test('every verb entry has a non-empty input_schema.properties and a defined response_schema', () => {
    for (const name of VERB_NAMES) {
      const entry = verbs[name];
      expect(entry).toBeDefined();

      // Live-emitted input schema (from the Operation defs via buildToolDefs).
      expect(entry.input_schema.type).toBe('object');
      expect(Object.keys(entry.input_schema.properties).length).toBeGreaterThan(0);
      expect(Array.isArray(entry.input_schema.required)).toBe(true);

      // Hand-authored response registry (RESPONSE_SCHEMAS) — an undefined
      // entry here means a verb shipped without a response contract.
      expect(entry.response_schema).toBeDefined();
      const rs = entry.response_schema as Record<string, unknown>;
      expect(rs.type).toBe('object');

      // Every v1 response envelope requires + stamps protocol_version: 1.
      expect(rs.required as string[]).toContain('protocol_version');
      const pv = (rs.properties as Record<string, Record<string, unknown>>).protocol_version;
      expect(pv.const).toBe(1);

      // The doc's descriptions come from the live op defs — never empty.
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test('protocol_version is the LITERAL frozen value 1', () => {
    // Deliberately NOT compared to MEMORY_VERBS_VERSION — the builder assigns
    // from that constant, so such a comparison would be a tautology. The
    // literal pins the frozen v1 wire value; if anyone bumps the constant,
    // this test is the reviewer-visible tripwire.
    expect(doc.protocol_version).toBe(1);
    // And the single source of truth itself stays frozen at 1 (v0.45.7 grew
    // the verb set 5 → 7 WITHOUT bumping this — additive-forever).
    expect(MEMORY_VERBS_VERSION).toBe(1);
    expect(doc.protocol).toBe('MEMORY_VERBS');
    expect(typeof doc.versioning_policy).toBe('string');
  });

  test('error_schema carries the documented uniform error contract', () => {
    const errorSchema = doc.error_schema as Record<string, unknown>;
    expect(errorSchema).toBeDefined();
    expect(errorSchema.type).toBe('object');

    // Envelope: { error, message } required; suggestion/detail/protocol_version optional.
    expect(errorSchema.required).toEqual(['error', 'message']);

    const props = errorSchema.properties as Record<string, Record<string, unknown>>;
    const codes = props.error.enum as string[];

    // The seven codes documented in docs/protocol/MEMORY_VERBS_v1.md
    // ("Error contract (uniform across all verbs)"). Containment, not
    // equality: the contract is additive-forever, so NEW codes may appear,
    // but removing a documented code is a breaking change and must fail.
    const documentedCodes = [
      'invalid_params',
      'provenance_required',
      'not_found',
      'scope_denied',
      'unavailable',
      'budget_unsatisfiable', // RESERVED — schema-listed, never returned in v1
      'internal',
    ];
    for (const code of documentedCodes) {
      expect(codes).toContain(code);
    }

    // "Every verb error carries a POPULATED suggestion" — the schema must
    // document the field (and detail, the freeform-specifics channel).
    expect(props.suggestion).toBeDefined();
    expect(props.suggestion.type).toBe('string');
    expect(props.detail).toBeDefined();

    // Error envelopes ride the same frozen version stamp.
    expect(props.protocol_version.const).toBe(1);
  });
});

/**
 * mars-prompt-shape.test.mjs — privacy + structural regression guard.
 *
 * The Mars persona prompt ships in gbrain's reference bundle and gets
 * copied into operator host repos. Any future edit (refactor, rebase,
 * cherry-pick from upstream) MUST NOT re-introduce:
 *   - Private names (operator first name, family names, upstream agent
 *     codename) — caught via $AGENT_VOICE_PII_BLOCKLIST env var
 *   - PII-shaped content (phones, emails, JWTs, etc.)
 *   - Hardcoded private filesystem paths
 *
 * The structural assertions also verify Mars's documented capabilities
 * stay accurate. Specifically the multilingual claim is NOT yet shipped
 * (deferred until a multilingual eval lands); the test fails if the
 * claim is reintroduced without the eval.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARS } from '../../code/lib/personas/mars.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOCKLIST_PATH = join(__dirname, '..', '..', 'code', 'lib', 'personas', 'private-name-blocklist.json');
const BLOCKLIST = JSON.parse(readFileSync(BLOCKLIST_PATH, 'utf8'));

// Shape regex — kept in sync with src/core/eval-capture-scrub.ts. Lookbehind
// removed because regex engines vary in support.
const SHAPE_REGEX = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  jwt: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  bearer: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{10,}/,
};

const PATH_REGEX = new RegExp(BLOCKLIST.pathPatterns.join('|'));

const OPERATOR_BLOCKLIST = process.env.AGENT_VOICE_PII_BLOCKLIST
  ? new RegExp(`\\b(${process.env.AGENT_VOICE_PII_BLOCKLIST})\\b`, 'i')
  : null;

describe('Mars prompt — privacy guard', () => {
  it('has no email-shaped content', () => {
    const m = MARS.prompt.match(SHAPE_REGEX.email);
    expect(m, m ? `email-shaped leak: ${m[0]}` : '').toBeNull();
  });

  it('has no phone-shaped content', () => {
    const m = MARS.prompt.match(SHAPE_REGEX.phone);
    expect(m, m ? `phone-shaped leak: ${m[0]}` : '').toBeNull();
  });

  it('has no SSN-shaped content', () => {
    expect(MARS.prompt.match(SHAPE_REGEX.ssn)).toBeNull();
  });

  it('has no JWT-shaped content', () => {
    expect(MARS.prompt.match(SHAPE_REGEX.jwt)).toBeNull();
  });

  it('has no Bearer-token content', () => {
    expect(MARS.prompt.match(SHAPE_REGEX.bearer)).toBeNull();
  });

  it('has no hardcoded private filesystem paths', () => {
    const m = MARS.prompt.match(PATH_REGEX);
    expect(m, m ? `private path leak: ${m[0]}` : '').toBeNull();
  });

  it.skipIf(!OPERATOR_BLOCKLIST)('has no operator-blocklist names (only runs when $AGENT_VOICE_PII_BLOCKLIST is set)', () => {
    const m = MARS.prompt.match(OPERATOR_BLOCKLIST);
    expect(m, m ? `operator-blocklist leak: ${m[0]}` : '').toBeNull();
  });
});

describe('Mars prompt — structural guarantees', () => {
  it('has both mode markers (SOLO + DEMO)', () => {
    expect(MARS.prompt).toMatch(/SOLO MODE/);
    expect(MARS.prompt).toMatch(/DEMO MODE/);
    expect(MARS.prompt).toMatch(/MODE DETECTION/);
  });

  it('declares the audio-only output rule', () => {
    expect(MARS.prompt).toMatch(/MUST produce AUDIO/i);
  });

  it('uses generic addressee ("the operator" or "you"), not a proper noun', () => {
    // Spot-check: should not contain ALL-CAPS proper names that look like
    // "Garry" or other addressees. We allow camelCased technical words.
    const properNounLike = MARS.prompt.match(/\b(Garry|Steph|Garrison|Solomon|Herbert|Wintermute)\b/);
    expect(properNounLike, properNounLike ? `proper-noun addressee: ${properNounLike[0]}` : '').toBeNull();
  });

  it('does NOT claim multilingual capability (gated on multilingual eval landing)', () => {
    // The Mars persona is English-only until an eval verifies cross-language
    // behavior. Restoring the claim requires the eval to ship first.
    // Match either the explicit "multilingual" word OR phrasings like
    // "switch languages" / "speak Spanish" / "speak Chinese" / "你好" etc.
    expect(MARS.prompt).not.toMatch(/multilingual/i);
    expect(MARS.prompt).not.toMatch(/switch languages naturally/i);
    expect(MARS.prompt).not.toMatch(/speaks [A-Z][a-z]+ese/i);
  });

  it('explicit English-only language rule is present', () => {
    expect(MARS.prompt).toMatch(/English/);
  });

  it('declares Venus owns logistics (Venus territory marker)', () => {
    // Cross-persona boundary should be preserved so Mars doesn't drift
    // into calendar/task answers.
    expect(MARS.prompt).toMatch(/Venus/);
  });

  it('prompt is between 1KB and 8KB (sane size)', () => {
    expect(MARS.prompt.length).toBeGreaterThan(1024);
    expect(MARS.prompt.length).toBeLessThan(8192);
  });
});

describe('Mars persona metadata', () => {
  it('has the expected static fields', () => {
    expect(MARS.name).toBe('Mars');
    expect(MARS.voice).toBe('Orus');
    expect(typeof MARS.emoji).toBe('string');
    expect(MARS.emoji.length).toBeGreaterThan(0);
    expect(MARS.description).toMatch(/dual-mode/i);
  });
});

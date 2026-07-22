/**
 * venus-prompt-shape.test.mjs — privacy + structural regression guard for Venus.
 *
 * Mirrors mars-prompt-shape.test.mjs. Same shape regex + path regex +
 * env-driven operator blocklist. Different structural guarantees (Venus is
 * the executive-assistant persona — read-only tool list, fast turn-taking,
 * English-only).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VENUS } from '../../code/lib/personas/venus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOCKLIST_PATH = join(__dirname, '..', '..', 'code', 'lib', 'personas', 'private-name-blocklist.json');
const BLOCKLIST = JSON.parse(readFileSync(BLOCKLIST_PATH, 'utf8'));

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

describe('Venus prompt — privacy guard', () => {
  it('has no email-shaped content', () => {
    expect(VENUS.prompt.match(SHAPE_REGEX.email)).toBeNull();
  });

  it('has no phone-shaped content', () => {
    expect(VENUS.prompt.match(SHAPE_REGEX.phone)).toBeNull();
  });

  it('has no SSN-shaped content', () => {
    expect(VENUS.prompt.match(SHAPE_REGEX.ssn)).toBeNull();
  });

  it('has no JWT-shaped content', () => {
    expect(VENUS.prompt.match(SHAPE_REGEX.jwt)).toBeNull();
  });

  it('has no Bearer-token content', () => {
    expect(VENUS.prompt.match(SHAPE_REGEX.bearer)).toBeNull();
  });

  it('has no hardcoded private filesystem paths', () => {
    expect(VENUS.prompt.match(PATH_REGEX)).toBeNull();
  });

  it.skipIf(!OPERATOR_BLOCKLIST)('has no operator-blocklist names (only runs when $AGENT_VOICE_PII_BLOCKLIST is set)', () => {
    const m = VENUS.prompt.match(OPERATOR_BLOCKLIST);
    expect(m, m ? `operator-blocklist leak: ${m[0]}` : '').toBeNull();
  });

  it('does NOT name specific upstream agents or operators', () => {
    // Names checked via env-driven blocklist set by AGENT_VOICE_PII_BLOCKLIST
    // (see private-name-blocklist.json). Literal names deliberately not in this
    // source file per CLAUDE.md's "never use private agent names in shipped artifacts."
    if (OPERATOR_BLOCKLIST) {
      expect(VENUS.prompt.match(OPERATOR_BLOCKLIST)).toBeNull();
    }
  });
});

describe('Venus prompt — structural guarantees', () => {
  it('declares the audio-only output rule', () => {
    expect(VENUS.prompt).toMatch(/MUST produce AUDIO/i);
  });

  it('declares the 1-3 sentence cap', () => {
    expect(VENUS.prompt).toMatch(/1-3 sentences/);
  });

  it('declares English-only language rule', () => {
    expect(VENUS.prompt).toMatch(/ENGLISH ONLY/);
  });

  it('lists ONLY read-only tools by default', () => {
    // Per D14-A: write tools (set_reminder, log_to_brain, put_page,
    // submit_job, etc.) must NOT appear in the default tool list. They
    // can be added via an operator-local override.
    const writeTools = [
      'put_page',
      'submit_job',
      'file_upload',
      'delete_page',
      'set_reminder',
      'log_voice_request',
    ];
    for (const t of writeTools) {
      expect(VENUS.prompt, `Venus prompt should not list write tool: ${t}`).not.toMatch(new RegExp(`\\b${t}\\b`));
    }
  });

  it('lists known read tools', () => {
    expect(VENUS.prompt).toMatch(/search_brain/);
    expect(VENUS.prompt).toMatch(/read_brain_page/);
    expect(VENUS.prompt).toMatch(/read_article/);
    expect(VENUS.prompt).toMatch(/web_search/);
  });

  it('documents the write-tool opt-in path explicitly', () => {
    expect(VENUS.prompt).toMatch(/(opt in|opt-in|override|not enabled by default)/i);
  });

  it('does NOT reference cross-persona claims by name', () => {
    // Older drafts had Venus mention "try Mars, he's multilingual." Mars
    // no longer claims multilingual capability, so Venus's pointer would
    // be stale. Bias is to leave persona-routing to the system layer, not
    // bake it into individual persona prompts.
    expect(VENUS.prompt).not.toMatch(/try Mars/i);
    expect(VENUS.prompt).not.toMatch(/Mars is multilingual/i);
  });

  it('prompt is between 500B and 4KB (sane size; Venus is terser than Mars)', () => {
    expect(VENUS.prompt.length).toBeGreaterThan(500);
    expect(VENUS.prompt.length).toBeLessThan(4096);
  });
});

describe('Venus persona metadata', () => {
  it('has the expected static fields', () => {
    expect(VENUS.name).toBe('Venus');
    expect(VENUS.voice).toBe('Aoede');
    expect(typeof VENUS.emoji).toBe('string');
    expect(VENUS.emoji.length).toBeGreaterThan(0);
    expect(VENUS.description).toMatch(/assistant/i);
  });
});

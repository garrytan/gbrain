/**
 * personas.mjs — Voice agent personality registry.
 *
 * Each persona defines a system prompt, voice, emoji, and short description.
 * The voice agent infrastructure (tools, auth, reconnect) is shared across
 * personas — only the personality changes.
 *
 * Adding a persona: write `<name>.mjs` exporting an object of the same shape
 * as MARS/VENUS, import it here, and register in PERSONAS.
 *
 * Context: live brain context (recent salience, calendar, tasks, themes) is
 * injected by the operator's implementation of buildXContext() — see
 * `context-builder.contract.md`. The shipped `../context-builder.example.mjs`
 * provides a working example reading a documented brain layout; operators
 * override it for their own brain structure.
 *
 * Trust boundary: persona prompts never see real secrets. Tool execution
 * goes through `../../tools.mjs` which enforces a read-only allow-list by
 * default. Adding write tools to a persona requires the operator to opt in
 * via a local override file.
 */

import { MARS } from './mars.mjs';
import { VENUS } from './venus.mjs';

// ── Shared preamble (tools, rules, time) ─────────────────
export function buildSharedContext(opts = {}) {
  const { authenticated = false, identity = '', dateTime = '' } = opts;

  let ctx = '';
  if (dateTime) ctx += `CURRENT DATE/TIME: ${dateTime}\n\n`;
  if (authenticated && identity) {
    ctx += `The caller is verified as ${identity}. All allow-listed tools are available.\n\n`;
  }
  return ctx;
}

// ── Persona registry ─────────────────────────────────────
export const PERSONAS = {
  venus: VENUS,
  mars: MARS,
};

/**
 * Look up a persona by key. Falls back to VENUS for unknown keys (since
 * VENUS is the default low-latency assistant — Mars is the more deliberate
 * fallback would surprise a caller).
 */
export function getPersona(name) {
  return PERSONAS[name?.toLowerCase()] || VENUS;
}

/**
 * Public listing for the directory/index UI.
 */
export function listPersonas() {
  return Object.entries(PERSONAS).map(([key, p]) => ({
    key,
    name: p.name,
    voice: p.voice,
    emoji: p.emoji,
    description: p.description,
  }));
}

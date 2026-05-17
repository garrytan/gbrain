/**
 * prompt.mjs — persona-aware system-prompt builder.
 *
 * Composes the final system prompt at session start:
 *
 *   [identity_section]      // "You ARE {persona.name}" — IDENTITY FIRST
 *   [shared_context]        // dateTime + authenticated identity (if any)
 *   [persona.prompt]        // mars or venus persona body
 *   [live_context]          // result of buildMarsContext / buildVenusContext
 *   [tool_table]            // names of allow-listed tools available this session
 *   [rules]                 // shared rules across personas
 *
 * "Identity-first" is the v0.8.1 production lesson: putting "You are Mars"
 * BEFORE any context keeps the model from drifting into a generic-assistant
 * voice mid-conversation.
 *
 * Sanitization: see `sanitizeForRealtime()` below — strips Unicode that the
 * OpenAI Realtime API has historically struggled with (em dashes, smart
 * quotes, arrows). Always runs over the assembled prompt.
 */

import { getPersona, buildSharedContext } from './lib/personas/personas.mjs';
import { getEffectiveAllowlist } from './tools.mjs';
import { buildMarsContext, buildVenusContext } from './lib/context-builder.example.mjs';

/**
 * Build the system prompt for a session.
 *
 * @param {object} opts
 * @param {string} opts.persona — 'mars' or 'venus' (case-insensitive)
 * @param {boolean} [opts.authenticated]
 * @param {string} [opts.identity] — operator identity if pre-auth
 * @param {string} [opts.dateTime] — ISO timestamp; defaults to now
 * @param {string} [opts.brainRoot] — absolute path to operator's brain repo
 * @param {string} [opts.timezone]
 * @returns {Promise<string>} sanitized system prompt
 */
export async function buildSystemPrompt(opts = {}) {
  const personaKey = (opts.persona || 'venus').toLowerCase();
  const persona = getPersona(personaKey);

  // 1. Identity first.
  let prompt = `# You ARE ${persona.name}\n`;
  prompt += `You are ${persona.name}, a voice AI. You are NOT a generic assistant. You are NOT Claude. You are NOT GPT. You are ${persona.name} with the personality below.\n\n`;

  // 2. Shared context (date/time + identity if authed).
  const dateTime = opts.dateTime || new Date().toISOString();
  prompt += buildSharedContext({
    authenticated: !!opts.authenticated,
    identity: opts.identity || '',
    dateTime,
  });

  // 3. Persona body.
  prompt += persona.prompt + '\n\n';

  // 4. Live brain context (operator's implementation; degrades to empty
  // string if no brainRoot or layout doesn't match).
  if (opts.brainRoot) {
    try {
      const ctx = personaKey === 'mars'
        ? await buildMarsContext({ brainRoot: opts.brainRoot, timezone: opts.timezone })
        : await buildVenusContext({ brainRoot: opts.brainRoot, timezone: opts.timezone });
      if (ctx) prompt += `# Live Context\n${ctx}\n\n`;
    } catch (err) {
      // Context-builder failures are non-fatal — persona answers with no
      // live context rather than crashing the call.
      console.warn(`[prompt] context-builder threw: ${err.message}`);
    }
  }

  // 5. Tool list — only the allow-list, never the denylist.
  const allowed = getEffectiveAllowlist();
  if (allowed.length > 0) {
    prompt += `# Available Tools\n`;
    prompt += `You can call these tools during conversation:\n`;
    for (const op of allowed) {
      prompt += `- ${op}\n`;
    }
    prompt += `Write operations are not available unless the operator has opted in locally. If you need to write something, say "I can't save from voice; tell me again when you're at your screen."\n\n`;
  }

  // 6. Final hard rules.
  prompt += `# Hard Rules\n`;
  prompt += `- Only the caller decides when the call ends. Never say goodbye. Never wrap up.\n`;
  prompt += `- If silence, ask "you still there?" — never fill it with assumptions.\n`;
  prompt += `- NEVER discuss connection quality or technical issues. Silently continue.\n`;
  prompt += `- NEVER read PII aloud (phones, emails, addresses).\n`;

  return sanitizeForRealtime(prompt);
}

/**
 * Strip Unicode characters that have historically broken the OpenAI
 * Realtime WebSocket connection in production. Em dashes, smart quotes,
 * arrows, ellipsis — replace with ASCII equivalents. Other non-ASCII
 * stripped entirely (kept conservative; multilingual support is deferred
 * to a future eval-gated release).
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForRealtime(text) {
  if (!text) return text;
  return text
    .replace(/[—–]/g, '--')    // em / en dash
    .replace(/[‘’]/g, "'")      // smart single quotes
    .replace(/[“”]/g, '"')      // smart double quotes
    .replace(/→/g, '->')               // right arrow
    .replace(/←/g, '<-')               // left arrow
    .replace(/…/g, '...')            // ellipsis
    .replace(/[^\x00-\x7F]/g, '');         // strip any other non-ASCII
}

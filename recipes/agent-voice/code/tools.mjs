/**
 * tools.mjs — voice-callable tool router with a READ-ONLY allow-list.
 *
 * D14-A invariant: the voice agent can READ from the brain but cannot WRITE.
 * Prompt injection of a persona prompt cannot escalate to brain-mutating ops
 * (put_page, submit_job, file_upload, delete_page, etc.) without explicit
 * operator opt-in via a local `tools-allowlist.local.json` override.
 *
 * Allow-list (default):
 *   - search                  (semantic + keyword search over pages/chunks)
 *   - query                   (RAG-shaped query with citations)
 *   - get_page                (fetch a single page by slug)
 *   - list_pages              (list pages with filters)
 *   - find_experts            (people/companies with topical relevance)
 *   - get_recent_salience     (recently-active emotionally-loaded pages)
 *   - get_recent_transcripts  (voice-note / meeting transcripts)
 *   - read_article            (fetch + summarize an arbitrary URL)
 *
 * Reject path: any tool name outside the allow-list returns a structured
 * error envelope. The voice agent surfaces it as "I can't do that from
 * voice." The router NEVER raises an exception that crashes the call.
 *
 * Local override: an operator who wants voice-callable writes places a
 * `tools-allowlist.local.json` next to this file with shape:
 *   { "extend": ["set_reminder", "log_to_brain"] }
 * Only operations declared in OPTIONAL_OPS below can be added — wholesale
 * write access (put_page, submit_job, etc.) is intentionally NOT
 * extensible from the override.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { callGbrainOp } from './gbrain-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default read-only allow-list. KEEP IN SYNC with tests/unit/tools-allowlist.test.mjs.
export const READ_ONLY_OPS = Object.freeze([
  'search',
  'query',
  'get_page',
  'list_pages',
  'find_experts',
  'get_recent_salience',
  'get_recent_transcripts',
  'read_article',
]);

// Optional ops the operator MAY opt in to via tools-allowlist.local.json.
// These are write-shaped but bounded: a reminder, a brain-log, an enrich
// nudge. Crucially: not put_page (no arbitrary brain edits), not submit_job
// (no shell), not file_upload, not delete_page.
export const OPTIONAL_OPS = Object.freeze([
  'set_reminder',
  'log_to_brain',
  'enrich_request',
]);

// Permanent denylist — never extendable via override, regardless of what the
// override file says. These cross the trust boundary in ways that would
// allow a prompt-injection attack to escalate to RCE or arbitrary write.
export const DENYLIST = Object.freeze([
  'put_page',
  'submit_job',
  'file_upload',
  'delete_page',
  'file_url',
  'sync_brain',
  'apply_migrations',
  'work',
  'shell',
]);

/**
 * Read the local override file (if present) and compute the effective
 * allow-list. The override may add OPTIONAL_OPS but cannot add DENYLIST ops.
 *
 * Result is memoized per-process (the override file is read once at first
 * call). Reset for tests by passing `{forceReload: true}`.
 */
let _effective;
export function getEffectiveAllowlist({ forceReload = false } = {}) {
  if (_effective && !forceReload) return _effective;

  const allowed = new Set(READ_ONLY_OPS);
  const overridePath = join(__dirname, 'tools-allowlist.local.json');
  if (existsSync(overridePath)) {
    try {
      const override = JSON.parse(readFileSync(overridePath, 'utf8'));
      if (Array.isArray(override?.extend)) {
        for (const name of override.extend) {
          if (typeof name !== 'string') continue;
          if (DENYLIST.includes(name)) {
            console.warn(`[tools] ignoring denylisted op in override: ${name}`);
            continue;
          }
          if (!OPTIONAL_OPS.includes(name)) {
            console.warn(`[tools] ignoring unknown op in override: ${name}`);
            continue;
          }
          allowed.add(name);
        }
      }
    } catch (err) {
      console.warn(`[tools] failed to parse ${overridePath}: ${err.message}`);
    }
  }

  _effective = Object.freeze([...allowed]);
  return _effective;
}

/**
 * Structured error envelope returned to the voice persona when a tool is
 * rejected. The persona sees this as a tool-call result, not as a thrown
 * exception, so the call never hangs.
 */
export function rejectedToolResult(opName, reason) {
  return {
    error: {
      code: reason,
      op: opName,
      message:
        reason === 'denylisted'
          ? `Tool "${opName}" is permanently disabled in voice agents. Use a different surface.`
          : `Tool "${opName}" is not in the voice agent's allow-list. The operator can opt in via tools-allowlist.local.json if appropriate.`,
    },
  };
}

/**
 * Dispatch a tool call from the voice persona to gbrain MCP.
 *
 * Returns either {data: <result>} on success or {error: <envelope>} on
 * rejection or MCP failure. Never throws.
 */
export async function dispatchTool(opName, params, { forceReload = false } = {}) {
  // Denylist check first — even if someone added it to the allow-list,
  // denylisted ops are never callable from voice.
  if (DENYLIST.includes(opName)) {
    return rejectedToolResult(opName, 'denylisted');
  }

  const allowlist = getEffectiveAllowlist({ forceReload });
  if (!allowlist.includes(opName)) {
    return rejectedToolResult(opName, 'not_in_allowlist');
  }

  // Allow-listed — call gbrain MCP.
  try {
    const result = await callGbrainOp(opName, params);
    return { data: result };
  } catch (err) {
    return {
      error: {
        code: 'mcp_error',
        op: opName,
        message: err?.message || String(err),
      },
    };
  }
}

/**
 * Inspect helper for tests / introspection. Returns the full picture.
 */
export function describeAllowlist({ forceReload = false } = {}) {
  return {
    read_only: [...READ_ONLY_OPS],
    optional: [...OPTIONAL_OPS],
    denylist: [...DENYLIST],
    effective: getEffectiveAllowlist({ forceReload }),
  };
}

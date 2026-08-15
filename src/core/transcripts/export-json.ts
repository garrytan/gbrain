/**
 * export-json.ts — shared loader for monolithic consumer-export JSON
 * (cathedral-4). One home for the cap/parse/shape checks and their error
 * strings so the two export adapters cannot drift apart: monolithic JSON
 * cannot be partially parsed, so over-cap files are REJECTED (never
 * truncated), and a zip or wrong-shape file gets the unzip-first hint.
 */

import { readFileSync, statSync } from 'node:fs';
import { TRANSCRIPT_EXPORT_JSON_HARD_CAP } from './types.ts';

/** Load an extracted conversations.json: returns the top-level array. */
export function loadExportConversations(
  path: string,
  opts: { maxBytes?: number; label: string },
): { data: unknown[]; bytes: number } {
  const cap = opts.maxBytes ?? TRANSCRIPT_EXPORT_JSON_HARD_CAP;
  const size = statSync(path).size;
  if (size > cap) {
    throw new Error(
      `${opts.label} export too large for import: ${size} bytes (cap ${cap}) — split the export`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `not an extracted conversations.json (unzip the export first): ${String(err)}`,
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(
      'not an extracted conversations.json (expected a top-level array) — unzip the export first',
    );
  }
  return { data, bytes: size };
}

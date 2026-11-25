/**
 * Lane 3 P2: profile importers. Pure parsers that turn another assistant's memory export into profile facts the
 * caller's own remember batches save (no new write op): Muse's Memory.md (`muse-memory`), the memories JSON in a
 * Claude data export (`claude-memories`) and the "[date] - memory" list Claude's import prompt asks any assistant to
 * print (`memory-text`). Credential-shaped rows are dropped before the preview and named by line, never printed.
 * The preview hash binds the parsed items, the file and the target (the profile and the principal writing it), so an
 * apply or a resume writes exactly what was previewed, to the same profile, as the same caller.
 */
import { createHash } from 'node:crypto';
import { scanText, TRANSCRIPT_LANE_SCAN_OPTS } from '../secret-scan.ts';
import { canonicalFacet } from './facets.ts';

export const IMPORT_FORMATS = ['muse-memory', 'claude-memories', 'memory-text'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
/** remember's batch cap: one batch is one remember call with its own request id. */
export const IMPORT_BATCH = 20;
const FACT_MAX = 2000;

export interface ImportItem { line: number; fact: string; facet: string; valid_from?: string }
export interface ImportDrop { line: number; reason: string }
export interface ImportPlan { format: ImportFormat; content_sha256: string; items: ImportItem[]; dropped: ImportDrop[] }
/** Whose profile the import writes and who writes it; part of the preview hash. */
export interface ImportTarget { principal: string; profile: string }

const HEADING_FACETS: Array<[RegExp, string]> = [
  [/allerg/, 'allergy'], [/diet|food|eat/, 'diet'], [/brand/, 'brand'], [/style|fashion|cloth/, 'style'],
  [/schedule|routine|calendar/, 'schedule'], [/household|family|home/, 'household'], [/constraint|restriction|avoid/, 'constraint'],
];

/** The facet a heading or a fact names, `other` when none: `Allergies` → allergy, `Shoe size: 10` → size.shoe. */
export function facetHint(heading: string | null, fact: string): string {
  const size = /^\s*([a-z][a-z0-9_-]{0,31})\s+size\b/i.exec(fact) ?? (heading && /size/i.test(heading) ? /^\s*([a-z][a-z0-9_-]{0,31})\s*:/i.exec(fact) : null);
  if (size) { const f = canonicalFacet(`size.${size[1]!.toLowerCase()}`); if (f) return f; }
  for (const text of [heading, fact]) {
    if (!text) continue;
    const hit = HEADING_FACETS.find(([re]) => re.test(text.toLowerCase()));
    if (hit && (text === heading || hit[1] === 'allergy')) return hit[1];
  }
  return 'other';
}

type Raw = { line: number; fact: string; heading: string | null; valid_from?: string };

function bullets(text: string): Raw[] {
  const out: Raw[] = [];
  let heading: string | null = null;
  text.split(/\r?\n/).forEach((l, i) => {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) { heading = h[1]!; return; }
    const b = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(l);
    if (b) out.push({ line: i + 1, fact: b[1]!, heading });
  });
  return out;
}

function memoryText(text: string): Raw[] {
  const out: Raw[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = /^\s*\[(\d{4}-\d{2}-\d{2})\]\s*[-\u2013\u2014:]\s*(.+?)\s*$/.exec(l);
    if (m) out.push({ line: i + 1, fact: m[2]!, heading: null, valid_from: m[1]! });
    else if (l.trim()) { const b = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(l); if (b) out.push({ line: i + 1, fact: b[1]!, heading: null }); }
  });
  return out;
}

function claudeMemories(text: string): Raw[] {
  const doc = JSON.parse(text) as unknown;
  const list = Array.isArray(doc) ? doc : (doc as { memories?: unknown }).memories;
  const out: Raw[] = [];
  const take = (v: unknown, n: number) => {
    if (typeof v === 'string') { out.push(...bullets(v).map(b => ({ ...b, line: n }))); if (!/^\s*[-*+]/m.test(v) && v.trim()) out.push({ line: n, fact: v.trim(), heading: null }); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const fact = [o.content, o.memory, o.text].find(x => typeof x === 'string') as string | undefined;
    const date = [o.created_at, o.updated_at].find(x => typeof x === 'string') as string | undefined;
    if (fact) out.push({ line: n, fact, heading: typeof o.category === 'string' ? o.category : null, ...(date && /^\d{4}-\d{2}-\d{2}/.test(date) ? { valid_from: date.slice(0, 10) } : {}) });
    else if (typeof o.conversations_memory === 'string') take(o.conversations_memory, n);
  };
  if (Array.isArray(list)) list.forEach((v, i) => take(v, i + 1));
  else if (doc && typeof doc === 'object') take(doc, 1);
  return out;
}

/** --format auto: JSON is claude-memories, a "[YYYY-MM-DD] - " list is memory-text, anything else is muse-memory. */
export function sniffFormat(text: string): ImportFormat {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[{') || t.startsWith('[\n') || t.startsWith('[ ')) { try { JSON.parse(text); return 'claude-memories'; } catch { /* not JSON */ } }
  return /^\s*\[\d{4}-\d{2}-\d{2}\]\s*[-\u2013\u2014:]/m.test(text) ? 'memory-text' : 'muse-memory';
}

/** Parses, drops credential-shaped and oversized rows, dedupes and assigns each item its facet. */
export function planImport(text: string, format: ImportFormat | 'auto'): ImportPlan {
  const fmt = format === 'auto' ? sniffFormat(text) : format;
  const raw = fmt === 'claude-memories' ? claudeMemories(text) : fmt === 'memory-text' ? memoryText(text) : bullets(text);
  const items: ImportItem[] = [];
  const dropped: ImportDrop[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const fact = r.fact.replace(/\s+/g, ' ').trim();
    if (!fact) continue;
    const secret = scanText(fact, TRANSCRIPT_LANE_SCAN_OPTS)[0];
    if (secret) { dropped.push({ line: r.line, reason: `credential-shaped (${secret.pattern})` }); continue; }
    if (fact.length > FACT_MAX) { dropped.push({ line: r.line, reason: `longer than ${FACT_MAX} characters` }); continue; }
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ line: r.line, fact, facet: facetHint(r.heading, fact), ...(r.valid_from ? { valid_from: r.valid_from } : {}) });
  }
  return { format: fmt, content_sha256: createHash('sha256').update(text).digest('hex'), items, dropped };
}

export function previewHash(plan: ImportPlan, target: ImportTarget): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, plan, target })).digest('hex').slice(0, 16);
}

/** One batch's remember request id: stable for the preview, so a re-run replays each batch instead of saving it again. */
export const batchRequestId = (hash: string, index: number): string => `profile-import-${hash}-b${index}`;

export function batches(plan: ImportPlan): ImportItem[][] {
  const out: ImportItem[][] = [];
  for (let i = 0; i < plan.items.length; i += IMPORT_BATCH) out.push(plan.items.slice(i, i + IMPORT_BATCH));
  return out;
}

/** The remember call for one batch: inferred, private, on the caller's own profile (no entity). */
export function batchParams(plan: ImportPlan, hash: string, index: number, items: ImportItem[], provenance: string): Record<string, unknown> {
  return {
    request_id: batchRequestId(hash, index), provenance, content_origin: 'inferred', visibility: 'private',
    items: items.map(i => ({ fact: i.fact, facet: i.facet, ...(i.valid_from ? { valid_from: i.valid_from } : {}) })),
  };
}

/**
 * Lane 3 P2: profile importers. Pure parsers that turn another assistant's memory export into profile facts the
 * caller's own remember batches save (no new write op): Muse's Memory.md (`muse-memory`), the memories JSON in a
 * Claude data export (`claude-memories`) and the "[date] - memory" list Claude's import prompt asks any assistant to
 * print (`memory-text`). Credential-shaped rows are dropped before the preview and named by line, never printed.
 * The preview hash binds the parsed items, the file and the target (the profile and the principal writing it), so an
 * apply or a resume writes exactly what was previewed, to the same profile, as the same caller.
 */
import { createHash } from 'node:crypto';
import { scanText, scanTextSpans, TRANSCRIPT_LANE_SCAN_OPTS } from '../secret-scan.ts';
import { isStrictIsoDateTime } from '../utils.ts';
import { opError } from '../ops/contract.ts';
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
  [/\ballerg/, 'allergy'], [/\b(diet|dietary|food|foods|eat|eats|eating)\b/, 'diet'], [/\bbrands?\b/, 'brand'], [/\b(style|fashion|clothes|clothing)\b/, 'style'],
  [/\b(schedule|routines?|calendar)\b/, 'schedule'], [/\b(household|family|home)\b/, 'household'], [/\b(constraints?|restrictions?|avoid)\b/, 'constraint'],
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

type Raw = { line: number; fact: string; heading: string | null; valid_from?: string } | { line: number; skip: string };

const HEADING = /^\s*(?:#{1,6}\s+(.+?)\s*#*|\*\*(.+?)\*\*:?|__(.+?)__:?)\s*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;

/** Lines of a Markdown memory list; with `prose`, a plain line under a heading is a fact too, else it is named as skipped. */
function bullets(text: string, prose = false): Raw[] {
  const out: Raw[] = [];
  let heading: string | null = null;
  text.split(/\r?\n/).forEach((l, i) => {
    const h = HEADING.exec(l);
    if (h) { heading = (h[1] ?? h[2] ?? h[3])!; return; }
    const b = BULLET.exec(l);
    if (b) out.push({ line: i + 1, fact: b[1]!, heading });
    else if (l.trim()) out.push(prose ? { line: i + 1, fact: l.trim(), heading } : { line: i + 1, skip: 'not a list item' });
  });
  return out;
}

/** A dated line's date, kept only when it is a real calendar date (remember refuses any other). */
const realDate = (d: string | undefined): string | undefined => d !== undefined && isStrictIsoDateTime(d) ? d : undefined;

function memoryText(text: string): Raw[] {
  const out: Raw[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = /^\s*\[(\d{4}-\d{2}-\d{2})\]\s*[-\u2013\u2014:]\s*(.+?)\s*$/.exec(l);
    const date = realDate(m?.[1]);
    if (m) out.push({ line: i + 1, fact: m[2]!, heading: null, ...(date ? { valid_from: date } : {}) });
    else if (l.trim()) { const b = BULLET.exec(l); out.push(b ? { line: i + 1, fact: b[1]!, heading: null } : { line: i + 1, skip: 'not a dated memory or list item' }); }
  });
  return out;
}

function claudeMemories(text: string): Raw[] {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch {
    throw opError('invalid_params', 'profile import: the file is not valid JSON; nothing was sent.',
      'Pass the memories JSON from a Claude data export, or --format muse-memory or memory-text for a text file.');
  }
  const list = Array.isArray(doc) ? doc : doc && typeof doc === 'object' ? (doc as { memories?: unknown }).memories : undefined;
  const out: Raw[] = [];
  const take = (v: unknown, n: number) => {
    const secret = typeof v === 'string' ? scanText(v, TRANSCRIPT_LANE_SCAN_OPTS)[0] : undefined;
    if (secret) { out.push({ line: n, skip: `credential-shaped (${secret.pattern})` }); return; }
    if (typeof v === 'string') { out.push(...bullets(v, true).map(b => ({ ...b, line: n }))); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const fact = [o.content, o.memory, o.text].find(x => typeof x === 'string') as string | undefined;
    const date = realDate(([o.created_at, o.updated_at].find(x => typeof x === 'string') as string | undefined)?.slice(0, 10));
    const factSecret = fact ? scanText(fact, TRANSCRIPT_LANE_SCAN_OPTS)[0] : undefined;
    if (factSecret) out.push({ line: n, skip: `credential-shaped (${factSecret.pattern})` });
    else if (fact) out.push({ line: n, fact, heading: typeof o.category === 'string' ? o.category : null, ...(date ? { valid_from: date } : {}) });
    else if (typeof o.conversations_memory === 'string') take(o.conversations_memory, n);
  };
  if (Array.isArray(list)) list.forEach((v, i) => take(v, i + 1));
  else if (doc && typeof doc === 'object') take(doc, 1);
  if (out.length === 0) out.push({ line: 1, skip: 'no memories found: expected a list of memories, {"memories": [...]}, or memory objects with content, memory, text or conversations_memory' });
  return out;
}

/** --format auto: JSON is claude-memories, a "[YYYY-MM-DD] - " list is memory-text, anything else is muse-memory. */
export function sniffFormat(text: string): ImportFormat {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) { try { JSON.parse(text); return 'claude-memories'; } catch { /* not JSON */ } }
  return /^\s*\[\d{4}-\d{2}-\d{2}\]\s*[-\u2013\u2014:]/m.test(text) ? 'memory-text' : 'muse-memory';
}

/** The 1-based lines of `text` a credential spans: a label on one line with its value on the next, or a key block. */
function credentialLines(text: string): Map<number, string> {
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;
  const out = new Map<number, string>();
  for (const span of scanTextSpans(text, TRANSCRIPT_LANE_SCAN_OPTS)) {
    if (!span.finding) continue;
    for (let l = lineAt(Math.min(span.from, span.start)); l <= lineAt(span.end); l++) out.set(l, span.finding.pattern);
  }
  return out;
}

const credential = (pattern: string): Raw => ({ line: 0, skip: `credential-shaped (${pattern})` });

/** Parses, drops credential-shaped and oversized rows, dedupes and assigns each item its facet. */
export function planImport(text: string, format: ImportFormat | 'auto'): ImportPlan {
  const fmt = format === 'auto' ? sniffFormat(text) : format;
  const parsed = fmt === 'claude-memories' ? claudeMemories(text) : fmt === 'memory-text' ? memoryText(text) : bullets(text);
  const inFile = fmt === 'claude-memories' ? new Map<number, string>() : credentialLines(text);
  const facts = parsed.filter(r => !('skip' in r)) as Array<Extract<Raw, { fact: string }>>;
  const acrossFacts = credentialLines(facts.map(f => f.fact.replace(/\s+/g, ' ')).join('\n'));
  const raw = parsed.map((r): Raw => {
    const pattern = inFile.get(r.line) ?? ('skip' in r ? undefined : acrossFacts.get(facts.indexOf(r) + 1));
    return pattern ? { ...credential(pattern), line: r.line } : r;
  });
  const items: ImportItem[] = [];
  const dropped: ImportDrop[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if ('skip' in r) { dropped.push({ line: r.line, reason: r.skip }); continue; }
    const fact = r.fact.replace(/\s+/g, ' ').trim();
    if (!fact) continue;
    const secret = scanText(fact, TRANSCRIPT_LANE_SCAN_OPTS)[0];
    if (secret) { dropped.push({ line: r.line, reason: `credential-shaped (${secret.pattern})` }); continue; }
    if (fact.length > FACT_MAX) { dropped.push({ line: r.line, reason: `longer than ${FACT_MAX} characters` }); continue; }
    const facet = facetHint(r.heading, fact);
    const key = JSON.stringify([fact.toLowerCase(), facet, r.valid_from ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ line: r.line, fact, facet, ...(r.valid_from ? { valid_from: r.valid_from } : {}) });
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

/**
 * The on-disk skill index (`index.bin`): a term dictionary plus flat
 * numeric postings, read lazily so a turn touches only the postings of its
 * own terms.
 *
 *   0   8 bytes  magic "GBSKIDX1"
 *   8   u32 LE   header length H
 *   12  32 bytes sha256 of the header JSON
 *   44  H bytes  header JSON (format, ranker, tokenizer, counts, sections)
 *   ... sections, each 8-byte aligned:
 *       avg      f64 x 5            mean field length (name, description, triggers, routing, body)
 *       lens     u32 x n x 5        field lengths per skill
 *       termOff  u32 x (terms + 1)  offsets into the decoded term string
 *       postOff  u32 x (terms + 1)  first posting of each term
 *       postDoc  u32 x postings     skill number of each posting
 *       postTf   u16 x postings x 5 term frequency per field
 *       metaOff  u32 x (n + 1)      offsets into the meta blob
 *       terms    utf-8              terms joined by "\n", sorted by JS string order
 *       meta     utf-8              one JSON object per skill: {id, name, summary, path?, ns?, t}
 *
 * The same records, variant and parameters always give the same bytes: no
 * clock, generation or path of the index itself goes in. The build receipt
 * (receipt.json) carries the build time, generation and the sha256 of these
 * bytes (index_hash). The turn path checks the magic, the header checksum
 * and the total size; the full hash is checked at build, status and doctor.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ResolverError } from './errors.ts';
import { lexTerms, TOKENIZER_ID } from './tokenize.ts';
import type { SkillRecord } from './sources.ts';

export const INDEX_FORMAT = 1;
export const RANKER_ID = 'bm25f-a5';
export const RANKER_VERSION = 1;
export const FIELDS = ['name', 'description', 'triggers', 'routing', 'body'] as const;
export type Field = (typeof FIELDS)[number];
export type Variant = 'D' | 'T';
export interface Bm25Params { k1: number; b: number; w: Record<Field, number> }

/** Frozen on the Step 1 dev split (gbrain-evals docs/benchmarks/2026-11-07-skill-ranker-offline, results/calibration.json, arm A5). */
export const VARIANT_PARAMS: Readonly<Record<Variant, Bm25Params>> = {
  D: { k1: 1.6, b: 0.75, w: { name: 2, description: 1, triggers: 0, routing: 0, body: 0.2 } },
  T: { k1: 0.9, b: 0.75, w: { name: 1, description: 1, triggers: 3, routing: 3, body: 0.2 } },
};
/** sha256 of the Step 1 dev split (data/dev.jsonl) the constants were tuned on. */
export const CALIBRATION_SPLIT_SHA256 = '7b39cb156940ea522d0d7053c67a550c40ef18170df4499f2961cf163742ba76';
export const HINT_CHARS = 120;
/** Unique terms one skill may post; far above what a 4 KB body and a bounded description produce. */
export const MAX_TERMS_PER_SKILL = 4096;

const MAGIC = 'GBSKIDX1';
const PREFIX = 44;

export function summaryOf(description: string): string {
  if (description.length <= HINT_CHARS) return description;
  const c = description.slice(0, HINT_CHARS);
  const sp = c.lastIndexOf(' ');
  return `${(sp > 40 ? c.slice(0, sp) : c).replace(/[\s,.;:]+$/, '')}…`;
}

export function fieldText(s: SkillRecord, f: Field, variant: Variant): string {
  if (f === 'name') return s.name.replace(/[-_:]/g, ' ');
  if (f === 'description') return s.whenToUse ? `${s.description} ${s.whenToUse}` : s.description;
  if (f === 'triggers') return variant === 'D' ? '' : s.triggers.join(' . ');
  if (f === 'routing') return variant === 'D' ? '' : s.routing.join(' . ');
  return s.body;
}

export interface SkillMeta { id: string; name: string; summary: string; path?: string; ns?: string; t: 0 | 1 }
export interface IndexHeader {
  format: number; endian: 'le'; ranker: { id: string; version: number; variant: Variant; params: Bm25Params }; tokenizer: string;
  n_skills: number; n_terms: number; n_postings: number; truncated_skills: number;
  sections: Record<'avg' | 'lens' | 'termOff' | 'postOff' | 'postDoc' | 'postTf' | 'metaOff' | 'terms' | 'meta', [number, number]>;
}

const align8 = (n: number) => (n + 7) & ~7;

/** Encode records (in the given order) into index bytes. */
export function encodeIndex(records: readonly SkillRecord[], variant: Variant): { bytes: Uint8Array; truncatedSkills: number } {
  const n = records.length;
  const lens = new Uint32Array(n * 5);
  const termDocs = new Map<string, number[]>();
  const termTfs = new Map<string, number[]>();
  let truncatedSkills = 0;
  records.forEach((s, doc) => {
    const per = new Map<string, number[]>();
    let truncated = false;
    FIELDS.forEach((f, fi) => {
      const toks = lexTerms(fieldText(s, f, variant));
      lens[doc * 5 + fi] = toks.length;
      for (const t of toks) {
        let v = per.get(t);
        if (!v) {
          if (per.size >= MAX_TERMS_PER_SKILL) { truncated = true; continue; }
          v = [0, 0, 0, 0, 0];
          per.set(t, v);
        }
        if (v[fi]! < 0xffff) v[fi]!++;
      }
    });
    if (truncated) truncatedSkills++;
    for (const [t, tf] of per) {
      let d = termDocs.get(t);
      if (!d) { d = []; termDocs.set(t, d); termTfs.set(t, []); }
      d.push(doc);
      termTfs.get(t)!.push(...tf);
    }
  });
  const avg = new Float64Array(5);
  for (let fi = 0; fi < 5; fi++) {
    let sum = 0;
    for (let d = 0; d < n; d++) sum += lens[d * 5 + fi]!;
    avg[fi] = Math.max(1e-9, n ? sum / n : 0);
  }
  const terms = [...termDocs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const termStr = terms.join('\n');
  const termOff = new Uint32Array(terms.length + 1);
  const postOff = new Uint32Array(terms.length + 1);
  let pos = 0;
  let nPost = 0;
  terms.forEach((t, i) => { termOff[i] = pos; pos += t.length + 1; postOff[i] = nPost; nPost += termDocs.get(t)!.length; });
  termOff[terms.length] = pos;
  postOff[terms.length] = nPost;
  const postDoc = new Uint32Array(nPost);
  const postTf = new Uint16Array(nPost * 5);
  let k = 0;
  for (const t of terms) {
    const docs = termDocs.get(t)!;
    const tfs = termTfs.get(t)!;
    for (let j = 0; j < docs.length; j++, k++) {
      postDoc[k] = docs[j]!;
      for (let f = 0; f < 5; f++) postTf[k * 5 + f] = tfs[j * 5 + f]!;
    }
  }
  const metaLines = records.map(s => JSON.stringify({ id: s.id, name: s.name, summary: summaryOf(s.description), ...(s.path ? { path: s.path } : {}), ...(s.namespace ? { ns: s.namespace } : {}), t: s.triggers.length || s.routing.length ? 1 : 0 }));
  const enc = new TextEncoder();
  const metaParts = metaLines.map(l => enc.encode(l));
  const metaOff = new Uint32Array(n + 1);
  let mpos = 0;
  metaParts.forEach((p, i) => { metaOff[i] = mpos; mpos += p.length; });
  metaOff[n] = mpos;
  const meta = new Uint8Array(mpos);
  mpos = 0;
  for (const p of metaParts) { meta.set(p, mpos); mpos += p.length; }
  const termBytes = enc.encode(termStr);
  const parts: [keyof IndexHeader['sections'], Uint8Array][] = [
    ['avg', new Uint8Array(avg.buffer)], ['lens', new Uint8Array(lens.buffer)], ['termOff', new Uint8Array(termOff.buffer)], ['postOff', new Uint8Array(postOff.buffer)],
    ['postDoc', new Uint8Array(postDoc.buffer)], ['postTf', new Uint8Array(postTf.buffer)], ['metaOff', new Uint8Array(metaOff.buffer)], ['terms', termBytes], ['meta', meta],
  ];
  const rel: Record<string, [number, number]> = {};
  let off = 0;
  for (const [name, b] of parts) { rel[name] = [off, b.length]; off = align8(off + b.length); }
  const bodyLen = off;
  // Header offsets are absolute; the header length depends on them, so settle it by iteration.
  let headerJson = '';
  let base = 0;
  for (let i = 0; i < 4; i++) {
    const sections = Object.fromEntries(Object.entries(rel).map(([k2, [o, l]]) => [k2, [base + o, l]])) as IndexHeader['sections'];
    const header: IndexHeader = { format: INDEX_FORMAT, endian: 'le', ranker: { id: RANKER_ID, version: RANKER_VERSION, variant, params: VARIANT_PARAMS[variant] }, tokenizer: TOKENIZER_ID,
      n_skills: n, n_terms: terms.length, n_postings: nPost, truncated_skills: truncatedSkills, sections };
    headerJson = JSON.stringify(header);
    const nextBase = align8(PREFIX + enc.encode(headerJson).length);
    if (nextBase === base) break;
    base = nextBase;
  }
  const hb = enc.encode(headerJson);
  const out = new Uint8Array(base + bodyLen);
  out.set(enc.encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(8, hb.length, true);
  out.set(createHash('sha256').update(hb).digest(), 12);
  out.set(hb, PREFIX);
  for (const [name, b] of parts) out.set(b, base + rel[name]![0]);
  return { bytes: out, truncatedSkills };
}

function incompatible(why: string, fixArgv?: string[]): ResolverError {
  return new ResolverError('skill_index_incompatible', `The skill index cannot be read by this gbrain (${why}).`, { suggestion: 'Rebuild the index with the command it was built with.', ...(fixArgv ? { argv: fixArgv } : {}) });
}

/** A lazily read index: the dictionary and lengths up front, postings and meta per request. */
export class IndexReader {
  readonly header: IndexHeader;
  readonly n: number;
  readonly avg: Float64Array;
  readonly lens: Uint32Array;
  private readonly termOff: Uint32Array;
  private readonly postOff: Uint32Array;
  private readonly terms: string;
  private readonly metaOff: Uint32Array;
  private readonly fd: number;
  private readonly metaCache = new Map<number, SkillMeta>();

  private constructor(fd: number, header: IndexHeader) {
    this.fd = fd;
    this.header = header;
    this.n = header.n_skills;
    const s = header.sections;
    this.avg = new Float64Array(this.read(...s.avg).buffer);
    this.lens = new Uint32Array(this.read(...s.lens).buffer);
    this.termOff = new Uint32Array(this.read(...s.termOff).buffer);
    this.postOff = new Uint32Array(this.read(...s.postOff).buffer);
    this.metaOff = new Uint32Array(this.read(...s.metaOff).buffer);
    this.terms = new TextDecoder().decode(this.read(...s.terms));
  }

  static open(path: string, fixArgv?: string[]): IndexReader {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ResolverError('skill_index_missing', 'The skill index file is missing.', { suggestion: 'Build it with gbrain skills index build.', ...(fixArgv ? { argv: fixArgv } : {}) });
      throw e;
    }
    try {
      const size = fstatSync(fd).size;
      const pre = new Uint8Array(PREFIX);
      if (size < PREFIX || readSync(fd, pre, 0, PREFIX, 0) !== PREFIX || new TextDecoder().decode(pre.subarray(0, 8)) !== MAGIC) throw incompatible('not a skill index', fixArgv);
      const hl = new DataView(pre.buffer).getUint32(8, true);
      if (hl > size - PREFIX || hl > 16 * 1024 * 1024) throw incompatible('a damaged header', fixArgv);
      const hb = new Uint8Array(hl);
      readSync(fd, hb, 0, hl, PREFIX);
      if (!Buffer.from(createHash('sha256').update(hb).digest()).equals(Buffer.from(pre.subarray(12, 44)))) throw incompatible('a damaged header', fixArgv);
      const header = JSON.parse(new TextDecoder().decode(hb)) as IndexHeader;
      if (header.format !== INDEX_FORMAT || header.endian !== 'le' || header.ranker?.id !== RANKER_ID || header.ranker.version !== RANKER_VERSION || header.tokenizer !== TOKENIZER_ID) {
        throw incompatible(`format ${header.format}, ranker ${header.ranker?.id} v${header.ranker?.version}`, fixArgv);
      }
      const end = Math.max(...Object.values(header.sections).map(([o, l]) => o + l));
      if (end > size || size - end > 8) throw incompatible('a truncated file', fixArgv);
      return new IndexReader(fd, header);
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }

  close(): void { try { closeSync(this.fd); } catch { /* closed */ } }

  private read(offset: number, length: number): Uint8Array {
    const b = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const r = readSync(this.fd, b, got, length - got, offset + got);
      if (r === 0) throw incompatible('a truncated file');
      got += r;
    }
    return b;
  }

  /** Index of a term in the sorted dictionary, or -1. */
  termIndex(term: string): number {
    let lo = 0;
    let hi = this.header.n_terms - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const t = this.terms.slice(this.termOff[mid]!, this.termOff[mid + 1]! - 1);
      if (t === term) return mid;
      if (t < term) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  df(ti: number): number { return this.postOff[ti + 1]! - this.postOff[ti]!; }

  postings(ti: number): { docs: Uint32Array; tfs: Uint16Array } {
    const a = this.postOff[ti]!;
    const c = this.postOff[ti + 1]! - a;
    const s = this.header.sections;
    return {
      docs: new Uint32Array(this.read(s.postDoc[0] + a * 4, c * 4).buffer),
      tfs: new Uint16Array(this.read(s.postTf[0] + a * 10, c * 10).buffer),
    };
  }

  meta(doc: number): SkillMeta {
    let m = this.metaCache.get(doc);
    if (!m) {
      const a = this.metaOff[doc]!;
      m = JSON.parse(new TextDecoder().decode(this.read(this.header.sections.meta[0] + a, this.metaOff[doc + 1]! - a))) as SkillMeta;
      this.metaCache.set(doc, m);
    }
    return m;
  }
}

#!/usr/bin/env bun
/**
 * Synthetic markdown brain generator for the efficiency bench (GBRA-66).
 * Opt-in, never run in CI. Generates generated words and generic names only
 * (alice-example style); no real page text, title or slug ever enters a shape
 * file or the output.
 *
 *   # 1) derive a shape (counts and sizes only) from a pull manifest
 *   bun scripts/bench/efficiency/synth-brain.ts shape --manifest <manifest.json> --source default --out shape.json
 *
 *   # 2) generate a brain from a shape (one directory per source)
 *   bun scripts/bench/efficiency/synth-brain.ts gen --shape shape.json --out <dir> [--scale 1] [--seed 42]
 *
 *   # 3) the built-in "full brain" shape (~5,000 pages over 8 sources), derived from a default-source shape
 *   bun scripts/bench/efficiency/synth-brain.ts full-shape --base shape.json --out shape-full.json
 *
 * Shape JSON:
 *   { "seed": 42, "sources": [ { "id": "default", "types": [
 *       { "type": "concept", "count": 14, "sizes": [bytes...], "timeline_per_page": 0.1,
 *         "wikilinks_per_kb": 0.4 } ] } ] }
 * `sizes` is the empirical body-size sample (bytes); `gen` draws from it with
 * +/-15% jitter, so `--scale 5` keeps the distribution while multiplying counts.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { flag, rng, writeJson } from './lib.ts';

export interface TypeShape { type: string; count: number; sizes: number[]; timeline_per_page: number; wikilinks_per_kb: number }
export interface SourceShape { id: string; types: TypeShape[] }
export interface Shape { seed: number; note?: string; sources: SourceShape[] }

const SYL = ['ka', 'lo', 'mi', 'ten', 'ra', 'vo', 'sil', 'den', 'ar', 'po', 'qui', 'nes', 'tor', 'bel', 'cas', 'ul', 'fin', 'gra', 'em', 'zo', 'pha', 'ret', 'lin', 'mo', 'sta', 'ber', 'ni', 'cor', 'tu', 'vex'];
const COMMON = ['the', 'and', 'of', 'to', 'in', 'for', 'with', 'on', 'is', 'that', 'by', 'as', 'from', 'this', 'it', 'at', 'be', 'or', 'an', 'we'];
const FIRST = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter', 'yolanda'];
const ORG = ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'vandelay', 'stark', 'wayne', 'tyrell', 'soylent'];

function vocab(seed: number, n = 3000): string[] {
  const r = rng(seed ^ 0x9e3779b9);
  const words = new Set<string>();
  while (words.size < n) {
    const k = 1 + Math.floor(r() * 3);
    let w = '';
    for (let i = 0; i < k; i++) w += SYL[Math.floor(r() * SYL.length)];
    words.add(w);
  }
  return [...words];
}

/** Generator state shared across one run so wikilinks point at pages that exist. */
export class Gen {
  private r: () => number;
  private words: string[];
  constructor(seed: number) {
    this.r = rng(seed);
    this.words = vocab(seed);
  }
  pick<T>(a: T[]): T { return a[Math.floor(this.r() * a.length)]!; }
  rand() { return this.r(); }
  word() { return this.r() < 0.35 ? this.pick(COMMON) : this.words[Math.floor(Math.pow(this.r(), 1.6) * this.words.length)]!; }
  sentence(): string {
    const n = 6 + Math.floor(this.r() * 16);
    const w: string[] = [];
    for (let i = 0; i < n; i++) w.push(this.word());
    const s = w.join(' ');
    return s[0]!.toUpperCase() + s.slice(1) + (this.r() < 0.1 ? '?' : '.');
  }
  person() { return `${this.pick(FIRST)}-example`; }
  org() { return `${this.pick(ORG)}-example`; }
  date(): string {
    const d = new Date(Date.UTC(2024, 0, 1) + Math.floor(this.r() * 1000) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
}

export function pageSlug(sourceId: string, type: string, i: number) {
  return `${type.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}/${sourceId}-${type.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${String(i).padStart(5, '0')}`;
}

/** One synthetic page body of ~`bytes` bytes with wikilinks and optional timeline. */
export function renderPage(g: Gen, opts: { type: string; title: string; bytes: number; linkTargets: string[]; wikilinksPerKb: number; timelineEntries: number; tags: string[] }): string {
  const fm = ['---', `type: ${opts.type}`, `title: "${opts.title}"`];
  if (opts.tags.length) fm.push(`tags: [${opts.tags.join(', ')}]`);
  fm.push(`created: ${g.date()}`, '---', '');
  const parts: string[] = [`# ${opts.title}`, ''];
  let size = fm.join('\n').length + parts.join('\n').length;
  const wantLinks = Math.round((opts.bytes / 1024) * opts.wikilinksPerKb);
  let links = 0;
  let para = 0;
  while (size < opts.bytes) {
    if (para % 5 === 0) {
      const h = `## ${g.sentence().split(' ').slice(0, 4).join(' ').replace(/[.?]$/, '')}`;
      parts.push(h, '');
      size += h.length + 2;
    }
    const sentences: string[] = [];
    const ns = 2 + Math.floor(g.rand() * 5);
    for (let i = 0; i < ns; i++) {
      let s = g.sentence();
      if (links < wantLinks && opts.linkTargets.length && g.rand() < 0.5) {
        const target = g.pick(opts.linkTargets);
        s = s.replace(/\.$/, '') + ` see [[${target}]].`;
        links++;
      } else if (g.rand() < 0.08) {
        s = s.replace(/\.$/, '') + ` with ${g.person().replace('-example', '')} from ${g.org().replace('-example', '')}.`;
      }
      sentences.push(s);
    }
    const p = g.rand() < 0.25 ? sentences.map((s) => `- ${s}`).join('\n') : sentences.join(' ');
    parts.push(p, '');
    size += p.length + 1;
    para++;
  }
  while (links < wantLinks && opts.linkTargets.length) {
    parts.push(`- Related: [[${g.pick(opts.linkTargets)}]]`);
    links++;
  }
  let out = fm.join('\n') + parts.join('\n').trimEnd() + '\n';
  if (opts.timelineEntries > 0) {
    const lines = ['', '<!-- timeline -->', ''];
    for (let i = 0; i < opts.timelineEntries; i++) lines.push(`- **${g.date()}** | ${g.person()} — ${g.sentence()}`);
    out += lines.join('\n') + '\n';
  }
  return out;
}

function jitter(g: Gen, sizes: number[]): number {
  const base = sizes.length ? sizes[Math.floor(g.rand() * sizes.length)]! : 2000;
  return Math.max(120, Math.round(base * (0.85 + g.rand() * 0.3)));
}

function poisson(g: Gen, mean: number): number {
  if (mean <= 0) return 0;
  const L = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do { k++; p *= g.rand(); } while (p > L && k < 1000);
  return k - 1;
}

export function generate(shape: Shape, outDir: string, scale = 1, seed = shape.seed ?? 42) {
  const g = new Gen(seed);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  const stats = { pages: 0, bytes: 0, timeline_entries: 0, sources: {} as Record<string, number> };
  for (const src of shape.sources) {
    const plan = src.types.map((t) => ({ ...t, n: Math.max(t.count > 0 ? 1 : 0, Math.round(t.count * scale)) }));
    const slugs = plan.flatMap((t) => Array.from({ length: t.n }, (_, i) => pageSlug(src.id, t.type, i)));
    let k = 0;
    for (const t of plan) {
      for (let i = 0; i < t.n; i++) {
        const slug = slugs[k++]!;
        const bytes = jitter(g, t.sizes);
        const te = poisson(g, t.timeline_per_page);
        const title = `${t.type} ${g.person()} ${i}`;
        const md = renderPage(g, { type: t.type, title, bytes, linkTargets: slugs, wikilinksPerKb: t.wikilinks_per_kb, timelineEntries: te, tags: g.rand() < 0.4 ? [`tag-${Math.floor(g.rand() * 30)}`] : [] });
        const file = join(outDir, src.id, `${slug}.md`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, md);
        stats.pages++;
        stats.bytes += md.length;
        stats.timeline_entries += te;
        stats.sources[src.id] = (stats.sources[src.id] ?? 0) + 1;
      }
    }
  }
  writeJson(join(outDir, 'synth-stats.json'), { scale, seed, ...stats });
  return stats;
}

/** Counts + sizes only, from a pull manifest. */
export function shapeFromManifest(manifestPath: string, sourceId: string, pullDir?: string): Shape {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const byType = new Map<string, { sizes: number[]; timeline: number; links: number; kb: number }>();
  for (const p of m.pages as any[]) {
    const type = String(p.type ?? 'concept');
    const bytes = Number(p.bytes ?? Math.round((p.approx_response_chars ?? p.response_bytes ?? 2000) * 0.9));
    const t = byType.get(type) ?? { sizes: [], timeline: 0, links: 0, kb: 0 };
    t.sizes.push(bytes);
    t.timeline += Number(p.timeline_count ?? 0);
    if (pullDir) {
      const f = join(pullDir, `${p.slug}.md`);
      if (existsSync(f)) {
        const text = readFileSync(f, 'utf8');
        t.links += (text.match(/\[\[/g) ?? []).length;
        t.kb += text.length / 1024;
      }
    }
    byType.set(type, t);
  }
  const types: TypeShape[] = [...byType.entries()].map(([type, t]) => ({
    type,
    count: t.sizes.length,
    sizes: t.sizes.sort((a, b) => a - b),
    timeline_per_page: Math.round((t.timeline / t.sizes.length) * 100) / 100,
    wikilinks_per_kb: t.kb > 0 ? Math.round((t.links / t.kb) * 100) / 100 : 0.3,
  }));
  return { seed: 42, note: `derived from ${sourceId} pull manifest: counts and sizes only`, sources: [{ id: sourceId, types }] };
}

/**
 * Full-brain shape (~5,000 pages): the source page counts come from the
 * hosted brain's list_pages totals; per-type size distributions reuse the
 * default-source shape. Session-like sources draw from the session size sample.
 */
export function fullShape(base: Shape): Shape {
  const types = base.sources[0]!.types;
  const session = types.find((t) => t.type.endsWith('session')) ?? types[0]!;
  const nonSession = types.filter((t) => t !== session);
  const totalNon = nonSession.reduce((a, t) => a + t.count, 0) || 1;
  const mixed = (id: string, n: number): SourceShape => ({ id, types: nonSession.map((t) => ({ ...t, count: Math.max(1, Math.round((t.count / totalNon) * n)) })) });
  const sessions = (id: string, n: number, type = 'session'): SourceShape => ({ id, types: [{ ...session, type, count: n }] });
  const notes = (id: string, n: number): SourceShape => ({ id, types: [{ ...(types.find((t) => t.type === 'concept') ?? types[0]!), type: 'note', count: n }] });
  return {
    seed: base.seed ?? 42,
    note: 'synthetic full-brain shape: source counts from hosted list_pages totals, sizes from the default-source shape',
    sources: [
      mixed('notes-main', 3700),
      sessions('sessions', 790),
      notes('notes-b', 210),
      notes('notes-c', 170),
      mixed('default', 85),
      notes('small-a', 25),
      notes('small-b', 15),
      notes('small-c', 5),
    ],
  };
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'shape') {
    const manifest = flag('manifest')!;
    const source = flag('source', 'default')!;
    const shape = shapeFromManifest(manifest, source, flag('pull-dir'));
    writeJson(flag('out')!, shape);
    console.log(JSON.stringify({ types: shape.sources[0]!.types.map((t) => ({ type: t.type, count: t.count })) }));
  } else if (cmd === 'full-shape') {
    const shape = fullShape(JSON.parse(readFileSync(flag('base')!, 'utf8')));
    writeJson(flag('out')!, shape);
    console.log(JSON.stringify(shape.sources.map((s) => ({ id: s.id, pages: s.types.reduce((a, t) => a + t.count, 0) }))));
  } else if (cmd === 'gen') {
    const shape = JSON.parse(readFileSync(flag('shape')!, 'utf8')) as Shape;
    const stats = generate(shape, flag('out')!, Number(flag('scale', '1')), Number(flag('seed', String(shape.seed ?? 42))));
    console.log(JSON.stringify(stats));
  } else {
    console.error('usage: synth-brain.ts shape|full-shape|gen ... (see header)');
    process.exit(2);
  }
}

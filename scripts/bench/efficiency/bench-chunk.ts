#!/usr/bin/env bun
/**
 * In-process chunk pass (GBRA-73): parse every markdown page under a
 * synthetic brain directory once, then time the importer's chunk
 * projection (`prepareMarkdownChunks`) over all pages, `--n` passes after
 * one warm-up pass. `--cjk <pages>` adds a generated mixed CJK / Latin /
 * emoji corpus instead of reading a directory, and `--cjk-prose <pages>` CJK
 * prose (frequent characters, sentence punctuation, few Latin terms). Prints per-pass p50/p95 and a
 * sha256 over every chunk, so a before/after pair is also an equivalence
 * check on the whole corpus. Opt-in, never run in CI; reads only.
 *
 *   bun scripts/bench/efficiency/bench-chunk.ts --data $BENCH_WORK/import/synth-full [--n 20]
 *   bun scripts/bench/efficiency/bench-chunk.ts --cjk 2000 [--n 20]
 *   bun scripts/bench/efficiency/bench-chunk.ts --cjk-prose 2000 [--n 20]
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown } from '../../../src/core/markdown.ts';
import { prepareMarkdownChunks } from '../../../src/core/markdown-chunks.ts';
import { flag, machine, pct, rng } from './lib.ts';

const N = Number(flag('n', '20'));
const data = flag('data');
const cjkPages = Number(flag('cjk', '0'));
const proseCjkPages = Number(flag('cjk-prose', '0'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.md') ? [p] : [];
  });
}

function cjkCorpus(count: number): Array<{ compiled_truth: string; timeline: string }> {
  const r = rng(73);
  const han = () => String.fromCharCode(0x4e00 + Math.floor(r() * 0x5200));
  const kana = () => String.fromCharCode(0x3041 + Math.floor(r() * 0xbe));
  const words = ['gbrain', 'search', 'API', 'v0.60', 'memory', 'note', '😀', '🚀'];
  const pages: Array<{ compiled_truth: string; timeline: string }> = [];
  for (let p = 0; p < count; p++) {
    const density = [0.2, 0.5, 0.9][p % 3]!;
    let body = '';
    const sentences = 20 + Math.floor(r() * 200);
    for (let s = 0; s < sentences; s++) {
      const len = 5 + Math.floor(r() * 40);
      for (let i = 0; i < len; i++) {
        body += r() < density ? (r() < 0.7 ? han() : kana()) : ` ${words[Math.floor(r() * words.length)]} `;
      }
      body += ['。', '！', '？', '. ', '，', '\n', '\n\n'][Math.floor(r() * 7)];
    }
    pages.push({ compiled_truth: body, timeline: '' });
  }
  return pages;
}

/** CJK prose shaped like real notes: frequent characters, sentence punctuation, few Latin terms. */
function cjkProseCorpus(count: number): Array<{ compiled_truth: string; timeline: string }> {
  const r = rng(74);
  const common = '的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从知全己体点长回正但现明问因外由意文重已加战度机位数门理被开位产话样表通无路论系最';
  const kana = ['です', 'ます', 'した', 'ない', 'という', 'から', 'まで', 'こと', 'もの', 'ように'];
  const terms = ['gbrain', 'API', 'v0.60', 'PostgreSQL', 'MCP'];
  const pages: Array<{ compiled_truth: string; timeline: string }> = [];
  for (let p = 0; p < count; p++) {
    let body = '';
    const paragraphs = 2 + Math.floor(r() * 12);
    for (let g = 0; g < paragraphs; g++) {
      const sentences = 2 + Math.floor(r() * 10);
      for (let s = 0; s < sentences; s++) {
        const len = 8 + Math.floor(r() * 32);
        for (let i = 0; i < len; i++) body += r() < 0.08 ? kana[Math.floor(r() * kana.length)] : common[Math.floor(r() * common.length)];
        if (r() < 0.15) body += ` ${terms[Math.floor(r() * terms.length)]} `;
        body += ['。', '，', '！', '？', '、'][Math.floor(r() * 5)];
      }
      body += '\n\n';
    }
    pages.push({ compiled_truth: body, timeline: '' });
  }
  return pages;
}

const pages = proseCjkPages > 0
  ? cjkProseCorpus(proseCjkPages)
  : cjkPages > 0
  ? cjkCorpus(cjkPages)
  : walk(data ?? (() => { throw new Error('--data <dir> or --cjk <pages>'); })()).map(f => {
      const parsed = parseMarkdown(readFileSync(f, 'utf8'), f);
      return { compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter };
    });

async function pass(): Promise<{ ms: number; chunks: number; hash: string }> {
  const h = createHash('sha256');
  let chunks = 0;
  const t = performance.now();
  for (const page of pages) {
    for (const c of await prepareMarkdownChunks(page)) {
      h.update(c.chunk_text);
      h.update('\u0000');
      chunks++;
    }
  }
  return { ms: performance.now() - t, chunks, hash: h.digest('hex').slice(0, 16) };
}

const warm = await pass();
const ms: number[] = [];
for (let i = 0; i < N; i++) {
  const r = await pass();
  if (r.hash !== warm.hash) throw new Error('chunk output changed between passes');
  ms.push(r.ms);
}
console.log(JSON.stringify({
  machine: machine(),
  corpus: proseCjkPages > 0 ? `cjk-prose-${proseCjkPages}` : cjkPages > 0 ? `cjk-${cjkPages}` : data,
  pages: pages.length,
  chunks: warm.chunks,
  chunk_sha256_16: warm.hash,
  mode: 'warm in-process',
  n: N,
  p50_ms: pct(ms, 0.5),
  p95_ms: pct(ms, 0.95),
}));

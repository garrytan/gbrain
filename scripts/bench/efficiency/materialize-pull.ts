#!/usr/bin/env bun
/**
 * Turn a hosted-brain pull (~/.capy/work/brain/pull/<source>/) into an
 * importable markdown directory. Opt-in, never run in CI; the output stays
 * under ~/.capy/work/brain/ and must never be committed.
 *
 *   bun scripts/bench/efficiency/materialize-pull.ts --source default [--out <dir>]
 *
 * Per page, in order of fidelity:
 *   <slug>.md         get_page `content` (canonical markdown)    -> copied as-is
 *   <slug>.page.json  get_page fields without `content`          -> serializeMarkdown()
 *   oversize          response too large to read through the pull channel
 *                     -> size- and type-matched synthetic stand-in (counted separately)
 * Prints counts only.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serializeMarkdown } from '../../../src/core/markdown.ts';
import { WORK, flag, writeJson } from './lib.ts';
import { Gen, renderPage } from './synth-brain.ts';

const source = flag('source', 'default')!;
const pull = join(WORK, 'pull', source);
const out = flag('out', join(WORK, 'import', `${source}-pull`, source))!;
const manifest = JSON.parse(readFileSync(join(WORK, 'pull', `manifest-${source}.json`), 'utf8'));
if (existsSync(out)) rmSync(out, { recursive: true, force: true });

const g = new Gen(7);
const counts = { content: 0, reconstructed: 0, standin: 0, missing: 0, bytes: 0 };
for (const p of manifest.pages as any[]) {
  const dest = join(out, `${p.slug}.md`);
  mkdirSync(dirname(dest), { recursive: true });
  const md = join(pull, `${p.slug}.md`);
  const pj = join(pull, `${p.slug}.page.json`);
  if (p.oversize) {
    const bytes = Math.round(Number(p.approx_response_chars ?? 20000) * 0.9);
    writeFileSync(dest, renderPage(g, { type: String(p.type ?? 'concept'), title: `${p.type} stand-in`, bytes, linkTargets: [], wikilinksPerKb: 0, timelineEntries: 0, tags: [] }));
    counts.standin++;
  } else if (!p.needs_reconstruct && existsSync(md)) {
    copyFileSync(md, dest);
    counts.content++;
  } else if (existsSync(pj)) {
    const f = JSON.parse(readFileSync(pj, 'utf8'));
    const { type: _t, title: _ti, tags: _ta, ...fm } = (f.frontmatter ?? {}) as Record<string, unknown>;
    writeFileSync(dest, serializeMarkdown(fm, f.compiled_truth ?? '', f.timeline ?? '', { type: f.type, title: f.title, tags: f.tags ?? [] }));
    counts.reconstructed++;
  } else {
    counts.missing++;
    continue;
  }
  counts.bytes += readFileSync(dest).length;
}
writeJson(join(dirname(out), 'materialize-stats.json'), { source, ...counts });
console.log(JSON.stringify({ source, out_pages: counts.content + counts.reconstructed + counts.standin, ...counts }));

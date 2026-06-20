/**
 * gbrain tags — tag-vocabulary hygiene for the brain.
 *
 * Keeps the tag vocabulary tight so pages actually connect instead of
 * fragmenting into synonyms. Tags live in each page's YAML frontmatter
 * (block or inline style); this command reads/writes those blocks directly
 * (the source of truth) and, on `merge --apply`, reconciles the engine
 * in-process (sync ADDS tags but never REMOVES them, so an explicit
 * removeTag is required — see operations.ts `remove_tag`).
 *
 * Usage:
 *   gbrain tags list  [--brain DIR] [--json]           All tags + page counts.
 *   gbrain tags audit [--brain DIR] [--json]           Cluster mechanical
 *                                                       near-duplicates
 *                                                       (case/separator/plural/
 *                                                       1-char typo). Read-only.
 *   gbrain tags merge <from> <to> [--apply] [--brain DIR]
 *                                                       Repoint every page using
 *                                                       <from> to <to>. Dry-run
 *                                                       by default; --apply
 *                                                       writes frontmatter AND
 *                                                       reconciles the engine.
 *
 * Deterministic mechanics only. Semantic synonyms (e.g. deep-work vs
 * flow-state) are NOT auto-detected — an LLM reviews `list` output for those
 * and calls `merge` on the ones it (and the user) confirm.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';

// ---- enumerate committed markdown pages under the brain dir ----
function pages(brain: string): string[] {
  let files: string[];
  try {
    files = execSync('git ls-files "*.md"', { cwd: brain, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    // fallback: walk the tree (skip dotdirs)
    files = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith('.')) walk(p);
        } else if (e.name.endsWith('.md')) {
          files.push(relative(brain, p));
        }
      }
    };
    walk(brain);
  }
  return files.map(f => join(brain, f));
}

// ---- frontmatter tag parsing (block + inline) ----
function readTags(file: string): string[] {
  const txt = readFileSync(file, 'utf8');
  if (!txt.startsWith('---')) return [];
  const end = txt.indexOf('\n---', 3);
  if (end < 0) return [];
  const fm = txt.slice(3, end).split('\n');
  const out: string[] = [];
  for (let i = 0; i < fm.length; i++) {
    const m = fm[i].match(/^tags:\s*(.*)$/);
    if (!m) continue;
    if (m[1].trim().startsWith('[')) {
      // inline: tags: [a, b]
      m[1].replace(/[[\]]/g, '').split(',').forEach(t => {
        const v = t.trim();
        if (v) out.push(v.replace(/^["']|["']$/g, ''));
      });
    } else {
      // block list
      for (let j = i + 1; j < fm.length; j++) {
        const li = fm[j].match(/^\s*-\s*(.+?)\s*$/);
        if (li) out.push(li[1].replace(/^["']|["']$/g, ''));
        else if (/^\S/.test(fm[j])) break; // next top-level key
      }
    }
    break;
  }
  return out;
}

// ---- rewrite a page's tags block in place ----
function writeTags(file: string, tags: string[]): void {
  const txt = readFileSync(file, 'utf8');
  const end = txt.indexOf('\n---', 3);
  const fm = txt.slice(3, end).split('\n');
  const out: string[] = [];
  let i = 0;
  let done = false;
  while (i < fm.length) {
    const m = fm[i].match(/^tags:\s*(.*)$/);
    if (m && !done) {
      out.push('tags:');
      tags.forEach(t => out.push(`  - ${t}`));
      done = true;
      i++;
      // skip the old block-list lines (inline value was already on the tags: line)
      if (!m[1].trim().startsWith('[')) {
        while (i < fm.length && /^\s*-\s*/.test(fm[i])) i++;
      }
      continue;
    }
    out.push(fm[i]);
    i++;
  }
  writeFileSync(file, '---' + out.join('\n') + txt.slice(end), 'utf8');
}

// ---- normalization for clustering ----
const norm = (t: string): string =>
  t.toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const singular = (t: string): string => t.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
const canonKey = (t: string): string => singular(norm(t));

function lev(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}

function tagCounts(brain: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of pages(brain)) for (const t of readTags(f)) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

interface AuditCluster {
  canonical: string;
  variants: string[];
  counts: Record<string, number>;
}

function auditClusters(brain: string): AuditCluster[] {
  const counts = tagCounts(brain);
  const tags = [...counts.keys()];
  // cluster by canonical key (case/separator/plural)
  const byKey = new Map<string, string[]>();
  for (const t of tags) {
    const k = canonKey(t);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(t);
  }
  const clusters: string[][] = [];
  for (const [, members] of byKey) if (members.length > 1) clusters.push(members);
  // add 1-char typo pairs not already clustered
  const seen = new Set<string>(clusters.flat());
  for (let i = 0; i < tags.length; i++)
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i], b = tags[j];
      if (seen.has(a) || seen.has(b)) continue;
      if (Math.min(a.length, b.length) >= 5 && lev(norm(a), norm(b)) === 1) {
        clusters.push([a, b]);
        seen.add(a);
        seen.add(b);
      }
    }
  return clusters.map(members => {
    const ranked = [...members].sort(
      (a, b) => (counts.get(b)! - counts.get(a)!) || a.length - b.length,
    );
    return {
      canonical: ranked[0],
      variants: ranked.slice(1),
      counts: Object.fromEntries(members.map(m => [m, counts.get(m)!])),
    };
  });
}

async function connectEngine(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
  return engine;
}

function printHelp(): void {
  console.log(`Usage: gbrain tags <list|audit|merge> [options]

Tag-vocabulary hygiene. Keeps tags tight so pages connect instead of
fragmenting into synonyms.

Subcommands:
  list                       All tags + page counts (prefer existing tags
                             before coining new ones). --json for machine output.
  audit                      Cluster mechanical near-duplicates
                             (case/separator/plural/1-char typo). Read-only.
                             --json for machine output.
  merge <from> <to>          Repoint every page using <from> to <to>.
                             Dry-run by default; --apply writes frontmatter AND
                             reconciles the engine (removeTag + addTag).

Options:
  --brain <dir>              Brain directory (default: current directory)
  --json                     Machine-readable output (list, audit)
  --apply                    Actually write (merge); omit for dry-run

Semantic synonyms (same idea, different word) are NOT auto-detected — review
\`list\` output and merge the ones you confirm.`);
}

export async function runTags(args: string[]): Promise<void> {
  const sub = args[0];
  const has = (name: string): boolean => args.includes(name);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] ?? null : null;
  };

  if (!sub || sub === '--help' || sub === '-h' || !['list', 'audit', 'merge'].includes(sub)) {
    printHelp();
    process.exit(sub && !['list', 'audit', 'merge'].includes(sub) ? 1 : 0);
  }

  const brain = flag('--brain') || '.';
  const asJson = has('--json');

  if (sub === 'list') {
    const counts = [...tagCounts(brain).entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    if (asJson) {
      console.log(JSON.stringify(counts.map(([tag, count]) => ({ tag, count }))));
      return;
    }
    console.log(`# ${counts.length} existing tags (prefer these before coining new ones):\n`);
    for (const [tag, n] of counts) console.log(`${String(n).padStart(3)}  ${tag}`);
    return;
  }

  if (sub === 'audit') {
    const report = auditClusters(brain);
    if (asJson) {
      console.log(JSON.stringify(report));
      return;
    }
    if (!report.length) {
      console.log('No mechanical tag duplicates found. (Semantic synonyms need LLM review of `list`.)');
      return;
    }
    console.log(`# ${report.length} consolidation candidate(s) — mechanical (case/separator/plural/typo):\n`);
    for (const r of report) {
      console.log(
        `→ keep "${r.canonical}" (${r.counts[r.canonical]}); merge: ${r.variants.map(v => `"${v}"(${r.counts[v]})`).join(', ')}`,
      );
      for (const v of r.variants) console.log(`   gbrain tags merge "${v}" "${r.canonical}" --apply`);
      console.log('');
    }
    console.log('Semantic synonyms (same idea, different word) are NOT listed here — review `list` output for those.');
    return;
  }

  // merge
  const from = args[1];
  const to = args[2];
  const apply = has('--apply');
  if (!from || !to || from.startsWith('-') || to.startsWith('-')) {
    console.error('Usage: gbrain tags merge <from> <to> [--apply] [--brain <dir>]');
    process.exit(1);
  }

  // First pass (filesystem): rewrite frontmatter, collect affected slugs.
  const changed: string[] = [];
  for (const f of pages(brain)) {
    const tags = readTags(f);
    if (!tags.includes(from)) continue;
    const next: string[] = [];
    for (const t of tags) {
      const v = t === from ? to : t;
      if (!next.includes(v)) next.push(v);
    }
    if (apply) writeTags(f, next); // disk = source of truth for future syncs
    changed.push(relative(brain, f).replace(/\.md$/, ''));
  }

  // Second pass (engine): reconcile in-process. sync only ADDS tags, so the
  // old tag must be removed explicitly; addTag is idempotent.
  if (apply && changed.length) {
    let engine: BrainEngine | null = null;
    try {
      engine = await connectEngine();
      for (const slug of changed) {
        try { await engine.removeTag(slug, from); } catch { /* page may not be in engine */ }
        try { await engine.addTag(slug, to); } catch { /* idem */ }
      }
    } finally {
      if (engine) await engine.disconnect();
    }
  }

  console.log(`${apply ? 'Merged' : 'Would merge'} "${from}" → "${to}" in ${changed.length} page(s):`);
  changed.forEach(c => console.log('  ' + c));
  if (apply && changed.length) console.log('\nEngine reconciled (removeTag + addTag). Next: commit + push the frontmatter changes.');
  else if (!apply && changed.length) console.log('\n(dry-run — re-run with --apply to write)');
}

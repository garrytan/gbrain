// gbrain reference <slug> [--unset] [--brain <dir>] [--json]
//
// Mark (or unmark) a page as a reference-only entity. A reference page keeps its
// real type (person/company) — fully searchable/enrichable/linkable — but is
// exempt from the entity coverage metrics (timeline_coverage,
// entity_link_coverage). See src/core/reference-flag.ts for the rationale.
//
// Durability: the flag is written to BOTH the markdown frontmatter (source of
// truth; survives re-ingest / engine rebuild) AND the engine `pages.frontmatter`
// JSONB (so the metric reflects it immediately, no re-sync needed).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { REFERENCE_FRONTMATTER_KEY } from '../core/reference-flag.ts';

/** Insert/replace/remove `reference: true` in a markdown frontmatter block.
 *  Minimal-diff: only the one line changes; key order is otherwise preserved. */
export function applyReferenceFrontmatter(content: string, on: boolean): string {
  const keyLine = `${REFERENCE_FRONTMATTER_KEY}: true`;
  const block = content.match(/^---\n([\s\S]*?)\n---/);

  if (!block) {
    // No frontmatter. Nothing to remove; if setting, prepend a block.
    if (!on) return content;
    return `---\n${keyLine}\n---\n\n${content}`;
  }

  let fm = block[1];
  const hasKey = new RegExp(`^${REFERENCE_FRONTMATTER_KEY}:.*$`, 'm').test(fm);

  if (on) {
    fm = hasKey
      ? fm.replace(new RegExp(`^${REFERENCE_FRONTMATTER_KEY}:.*$`, 'm'), keyLine)
      : `${fm}\n${keyLine}`;
  } else {
    if (!hasKey) return content;
    fm = fm.replace(new RegExp(`^${REFERENCE_FRONTMATTER_KEY}:.*$\\n?`, 'm'), '');
  }

  // Function replacement so YAML chars ($, & …) in fm aren't treated as
  // replacement patterns.
  return content.replace(/^---\n[\s\S]*?\n---/, () => `---\n${fm}\n---`);
}

function parseArgs(args: string[]): { slug?: string; unset: boolean; json: boolean; brain?: string } {
  let slug: string | undefined;
  let unset = false;
  let json = false;
  let brain: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--unset') unset = true;
    else if (a === '--json') json = true;
    else if (a === '--brain' || a === '--dir') brain = args[++i];
    else if (!a.startsWith('--') && !slug) slug = a;
  }
  return { slug, unset, json, brain };
}

async function resolveBrainDir(engine: BrainEngine, explicit?: string): Promise<string | null> {
  if (explicit) return resolve(explicit);
  const configured = await engine.getConfig('sync.repo_path');
  if (configured && existsSync(configured)) return resolve(configured);
  return null;
}

export async function runReference(engine: BrainEngine, args: string[]): Promise<void> {
  const { slug, unset, json, brain } = parseArgs(args);
  if (!slug) {
    console.error('Usage: gbrain reference <slug> [--unset] [--brain <dir>] [--json]');
    process.exitCode = 2;
    return;
  }

  const brainDir = await resolveBrainDir(engine, brain);
  if (!brainDir) {
    console.error('reference: could not resolve brain dir. Pass --brain <dir> or set sync.repo_path.');
    process.exitCode = 1;
    return;
  }

  const rel = slug.endsWith('.md') ? slug : `${slug}.md`;
  const filePath = isAbsolute(rel) ? rel : join(brainDir, rel);
  if (!existsSync(filePath)) {
    console.error(`reference: page not found on disk: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  // 1) Durable: edit the markdown frontmatter.
  const before = readFileSync(filePath, 'utf8');
  const after = applyReferenceFrontmatter(before, !unset);
  const fileChanged = after !== before;
  if (fileChanged) writeFileSync(filePath, after, 'utf8');

  // 2) Immediate: update the engine frontmatter JSONB so the metric reflects it
  //    without waiting for a re-sync.
  const cleanSlug = slug.replace(/\.md$/, '');
  if (unset) {
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = frontmatter - '${REFERENCE_FRONTMATTER_KEY}' WHERE slug = $1`,
      [cleanSlug],
    );
  } else {
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = jsonb_set(COALESCE(frontmatter, '{}'::jsonb), '{${REFERENCE_FRONTMATTER_KEY}}', 'true'::jsonb) WHERE slug = $1`,
      [cleanSlug],
    );
  }

  const result = { slug: cleanSlug, reference: !unset, file_changed: fileChanged, file: filePath };
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    const verb = unset ? 'unmarked' : 'marked';
    console.log(`${verb} ${cleanSlug} as reference=${!unset}${fileChanged ? '' : ' (frontmatter already current)'}`);
    console.log('  → exempt from timeline_coverage / entity_link_coverage; still fully searchable & linkable.');
  }
}

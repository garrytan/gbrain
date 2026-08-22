import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { loadSourceRow } from '../contextual-retrieval-service.ts';

export function readSummaryBody(page: Page): string {
  const compiled = page.compiled_truth ?? '';
  const timeline = page.timeline ?? '';
  if (!compiled) return timeline;
  if (!timeline) return compiled;
  return `${compiled}\n\n${timeline}`;
}

function extractRawTranscriptPath(page: Page): string | null {
  const raw = page.frontmatter?.raw_transcript;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve `rel` against `root`, rejecting any result that escapes the root
 * (`../`-style traversal in frontmatter is untrusted data — a page synced
 * from a mounted repo must not read arbitrary host files). Returns the
 * resolved absolute path, or null on escape.
 */
function resolveWithinRoot(root: string, rel: string): string | null {
  const rootAbs = resolve(root);
  const candidate = resolve(rootAbs, rel);
  if (candidate === rootAbs || candidate.startsWith(rootAbs + sep)) return candidate;
  return null;
}

/**
 * #3911: a RELATIVE `raw_transcript` is repo-relative — but "the repo" is the
 * page's OWNING source, not the brain-global `sync.repo_path`. Multi-source
 * brains stored transcripts per source; resolving every page against the
 * global repo path silently read the wrong file (or nothing) for any page
 * outside that one repo. Resolution order:
 *
 *   1. absolute path — accepted only when it lands INSIDE a registered root
 *      (the owning source's `local_path`, else `sync.repo_path`). Frontmatter
 *      is untrusted data, so an absolute `/etc/passwd`-style path is rejected
 *      the same as `../` traversal (#3911 follow-up);
 *   2. page.source_id's source row `local_path` — escape-checked;
 *   3. `sync.repo_path` fallback (source row missing / no local_path) —
 *      also escape-checked.
 *
 * A RELATIVE path that ESCAPES its root is rejected outright (returns null →
 * caller falls back to the summary body); it does not retry lower tiers.
 * An ABSOLUTE path may sit in either root (containment, not resolution).
 */
async function resolveTranscriptPath(
  engine: BrainEngine,
  page: Page,
  rawTranscript: string,
): Promise<string | null> {
  let sourceLocalPath: string | null = null;
  if (page.source_id) {
    try {
      sourceLocalPath = (await loadSourceRow(engine, page.source_id)).local_path;
    } catch {
      // Unknown source id / sources table unavailable — fall through to the
      // brain-global repo path, the pre-#3911 behavior.
    }
  }
  if (isAbsolute(rawTranscript)) {
    // resolveWithinRoot handles absolute candidates: resolve(root, abs) is
    // abs itself, so this is a pure containment check against each root.
    if (sourceLocalPath) {
      const contained = resolveWithinRoot(sourceLocalPath, rawTranscript);
      if (contained) return contained;
    }
    const repoPath = await engine.getConfig('sync.repo_path');
    if (repoPath) {
      const contained = resolveWithinRoot(repoPath, rawTranscript);
      if (contained) return contained;
    }
    return null; // outside every registered root — fail closed
  }
  if (sourceLocalPath) return resolveWithinRoot(sourceLocalPath, rawTranscript);
  const repoPath = await engine.getConfig('sync.repo_path');
  if (repoPath) return resolveWithinRoot(repoPath, rawTranscript);
  return null;
}

export async function readConversationBodyForParsing(
  engine: BrainEngine,
  page: Page,
): Promise<string> {
  const rawTranscript = extractRawTranscriptPath(page);
  if (rawTranscript) {
    const resolved = await resolveTranscriptPath(engine, page, rawTranscript);
    if (resolved && existsSync(resolved)) {
      const rawBody = readFileSync(resolved, 'utf8').trim();
      if (rawBody.length > 0) return rawBody;
    }
  }
  return readSummaryBody(page);
}

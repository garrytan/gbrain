import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { loadSourceRow } from '../contextual-retrieval-service.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { CONVERSATION_WINDOW_BYTES, readSegmentedConversationInput, type SegmentedConversationInput } from '../page-body/segment-conversation.ts';

/**
 * The largest conversation parser input (UTF-8 bytes): the page ceiling plus
 * 1 MiB of headroom (25 MiB today, the historical cap). Derived from
 * PAGE_MAX_BYTES so it moves with the ceiling and never sits below it, so no
 * page ingest accepts is skipped for size. A `raw_transcript` sidecar over it
 * is never read.
 */
export const CONVERSATION_BODY_MAX_BYTES = PAGE_MAX_BYTES + 1024 ** 2;

/** A `raw_transcript` sidecar over CONVERSATION_BODY_MAX_BYTES: refused from its size before any read. */
export class ConversationBodyTooLargeError extends Error {
  constructor(readonly bytes: number, readonly mtimeMs: number) {
    super(`raw_transcript sidecar is ${bytes} bytes, over the ${CONVERSATION_BODY_MAX_BYTES}-byte conversation body cap; it was not read`);
    this.name = 'ConversationBodyTooLargeError';
  }
}

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
 *
 * Symlink hardening: lexical containment alone is not enough — a symlink
 * INSIDE the root can point OUTSIDE it. When the candidate exists, its
 * realpath must also stay inside the root's realpath; the realpath is what
 * gets returned so the read hits the verified target.
 */
function resolveWithinRoot(root: string, rel: string): string | null {
  const rootAbs = resolve(root);
  const candidate = resolve(rootAbs, rel);
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) return null;
  try {
    if (existsSync(candidate)) {
      const rootReal = realpathSync(rootAbs);
      const fileReal = realpathSync(candidate);
      if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) return null;
      return fileReal;
    }
  } catch {
    return null;
  }
  return candidate;
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
 * Every containment check is realpath-hardened (see resolveWithinRoot), so a
 * symlink inside a root that points outside it is refused, not followed.
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

/** The parser input: the `raw_transcript` sidecar when it resolves and is non-empty, else the summary body. Throws ConversationBodyTooLargeError for an oversized sidecar. */
export async function readConversationBodyForParsing(
  engine: BrainEngine,
  page: Page,
): Promise<string> {
  return (await readConversationInput(engine, page)).body;
}

/**
 * readConversationBodyForParsing with the window it read: a segmented page's summary body is read through ranged
 * reads, and one over CONVERSATION_WINDOW_BYTES is its newest window (page-body/segment-conversation.ts). With
 * `priorFacts`, a page over the window that has conversation facts is not read at all: its input is empty and the
 * window carries the count (the run keeps those facts and skips the page). `sidecar` marks an input read from the
 * `raw_transcript` file rather than the page.
 */
export async function readConversationInput(
  engine: BrainEngine,
  page: Page,
  opts: { priorFacts?: () => Promise<number> } = {},
): Promise<SegmentedConversationInput & { sidecar?: true }> {
  const rawTranscript = extractRawTranscriptPath(page);
  if (rawTranscript) {
    const resolved = await resolveTranscriptPath(engine, page, rawTranscript);
    if (resolved && existsSync(resolved)) {
      const { size, mtimeMs } = statSync(resolved);
      if (size > CONVERSATION_BODY_MAX_BYTES) throw new ConversationBodyTooLargeError(size, mtimeMs);
      const rawBody = readFileSync(resolved, 'utf8').trim();
      if (rawBody.length > 0) return { body: rawBody, sidecar: true };
    }
    if (!resolved) {
      // Refusal is loud but class-only: never echo the attempted path
      // (existence-oracle discipline) — frontmatter is untrusted data.
      console.warn(
        '[conversation-parser] raw_transcript refused (containment); falling back to summary body',
      );
    }
  }
  if (!isSegmentedPage(page)) return { body: readSummaryBody(page) };
  const totalBytes = Number(page.body_bytes);
  const priorFacts = totalBytes > CONVERSATION_WINDOW_BYTES ? await opts.priorFacts?.() ?? 0 : 0;
  if (priorFacts > 0) return { body: '', window: { totalBytes, fallbackDate: null, priorFacts } };
  return readSegmentedConversationInput(engine, page);
}

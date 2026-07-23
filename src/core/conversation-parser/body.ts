import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';

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

export async function readConversationBodyForParsing(
  engine: BrainEngine,
  page: Page,
): Promise<string> {
  const rawTranscript = extractRawTranscriptPath(page);
  if (rawTranscript) {
    const repoPath = await engine.getConfig('sync.repo_path');
    const resolved = isAbsolute(rawTranscript)
      ? rawTranscript
      : repoPath
        ? join(repoPath, rawTranscript)
        : null;
    if (resolved && existsSync(resolved)) {
      const rawBody = readFileSync(resolved, 'utf8').trim();
      if (rawBody.length > 0) return rawBody;
    }
  }
  return readSummaryBody(page);
}

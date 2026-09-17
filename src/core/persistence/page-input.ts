import type { OperationContext } from '../ops/contract.ts';
import { MAX_FILE_SIZE } from '../import-file.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import { loadActivePackForWriteVocabulary } from '../schema-pack/write-vocabulary.ts';
import { classifyStoredType, sanitizeTypeForDisplay } from '../schema-pack/type-usage.ts';

/** Normalize model-authored types once at admission, after an existing UUID has replayed. */
export async function normalizeSubagentPageInput(ctx: OperationContext, intent: Record<string, unknown>): Promise<void> {
  if (ctx.viaSubagent !== true || !ctx.allowedSlugPrefixes?.length
    || typeof intent.content !== 'string' || typeof intent.slug !== 'string') return;
  // A rewrite must not shrink an oversized raw request below the import guard.
  if (Buffer.byteLength(intent.content, 'utf8') > MAX_FILE_SIZE) return;
  let parsed: ReturnType<typeof parseMarkdown>;
  try { parsed = parseMarkdown(intent.content, `${intent.slug}.md`); }
  catch { return; } // The importer owns the sanitized parse-error contract.
  if (parsed.typeExplicit !== true) return;
  const pack = await loadActivePackForWriteVocabulary(ctx);
  if (!pack || classifyStoredType(parsed.type, pack.manifest).kind !== 'undeclared') return;
  intent.content = serializeMarkdown({ ...parsed.frontmatter, legacy_type: parsed.type },
    parsed.compiled_truth, parsed.timeline, { type: 'note', title: parsed.title, tags: parsed.tags });
  ctx.logger.warn(`undeclared type '${sanitizeTypeForDisplay(parsed.type)}' normalized to 'note' `
    + `(legacy_type kept; pack ${pack.manifest.name})`);
}

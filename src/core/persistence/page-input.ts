import type { OperationContext } from '../ops/contract.ts';
import { MAX_FILE_SIZE } from '../import-file.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import { loadActivePackForWriteVocabulary, undeclaredPageTypeMessage, undeclaredPageTypeSuggestion } from '../schema-pack/write-vocabulary.ts';
import { classifyStoredType, safeCliToken, sanitizeTypeForDisplay } from '../schema-pack/type-usage.ts';

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

export interface PageTypeWarning {
  code: 'page_type_undeclared';
  type: string;
  pack: string;
  cause: string;
  fix: string;
  docs: string;
}

/**
 * #5880: put_page stores an explicit type the write source's active pack
 * neither declares nor aliases as-is (warn, never reject); the caller gets
 * this warning in the committed result and on its logger. #8507: so does a capture stored under the default type.
 */
export async function undeclaredPageTypeWarning(ctx: OperationContext, intent: Record<string, unknown>, sourceId: string, surface = 'put_page'): Promise<PageTypeWarning | null> {
  if (typeof intent.content !== 'string' || typeof intent.slug !== 'string') return null;
  let parsed: ReturnType<typeof parseMarkdown>;
  try { parsed = parseMarkdown(intent.content, `${intent.slug}.md`); }
  catch { return null; }
  if (parsed.typeExplicit !== true) return null;
  const pack = await loadActivePackForWriteVocabulary({ engine: ctx.engine, remote: ctx.remote, sourceId });
  if (!pack || classifyStoredType(parsed.type, pack.manifest).kind !== 'undeclared') return null;
  const type = sanitizeTypeForDisplay(parsed.type);
  const warning: PageTypeWarning = {
    code: 'page_type_undeclared',
    type,
    pack: pack.manifest.name,
    cause: `${undeclaredPageTypeMessage(type, pack, surface)} The page was stored with this type as-is.`,
    fix: `${undeclaredPageTypeSuggestion(pack)} To declare it: gbrain schema add-type ${safeCliToken(parsed.type) ?? '<type>'} (with its primitive and prefix)`,
    docs: 'docs/architecture/schema-packs.md#undeclared-page-types',
  };
  ctx.logger.warn(`[${warning.code}] ${warning.cause} ${warning.fix}`);
  return warning;
}

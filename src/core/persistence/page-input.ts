import type { OperationContext } from '../ops/contract.ts';
import { MAX_FILE_SIZE } from '../import-file.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import { loadActivePackForWriteVocabulary, undeclaredPageTypeMessage, undeclaredPageTypeSuggestion } from '../schema-pack/write-vocabulary.ts';
import { classifyStoredType, safeCliToken, sanitizeTypeForDisplay } from '../schema-pack/type-usage.ts';
import { stripNul } from '../batch-rows.ts';
import { nulSelectorError } from './page-edit.ts';

/** The parameters holding the page text each page mutation writes (append_page refuses U+0000 in page-append.ts). */
const PAGE_TEXT_PARAMS: Record<string, string[]> = { put_page: ['content'], add_timeline_entry: ['summary', 'detail', 'source'] };

/**
 * GST-3170: Postgres text and jsonb cannot hold U+0000, so a page write whose text carried one failed whole with
 * "unsupported Unicode escape sequence". It is removed from the page text here, before the intent is journaled, so the
 * canonical file, the stored page and every row derived from it read the same text; every other character stays as
 * written. Returns how many were removed.
 */
export function stripPageTextNul(operation: string, params: Record<string, unknown>): number {
  let removed = 0;
  const strip = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const out = stripNul(value);
    removed += value.length - out.length;
    return out;
  };
  for (const key of PAGE_TEXT_PARAMS[operation] ?? []) if (Object.hasOwn(params, key)) params[key] = strip(params[key]);
  if (operation !== 'edit_page' || !Array.isArray(params.edits)) return removed;
  params.edits = params.edits.map((edit: unknown, index: number) => {
    if (!edit || typeof edit !== 'object') return edit;
    const { old_text, new_text } = edit as { old_text?: unknown; new_text?: unknown };
    if (typeof old_text === 'string' && old_text.includes('\0')) {
      throw nulSelectorError(index);
    }
    return { ...edit, new_text: strip(new_text) };
  });
  return removed;
}

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
 * this warning in the committed result and on its logger.
 */
export async function undeclaredPageTypeWarning(ctx: OperationContext, intent: Record<string, unknown>, sourceId: string): Promise<PageTypeWarning | null> {
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
    cause: `${undeclaredPageTypeMessage(type, pack, 'put_page')} The page was stored with this type as-is.`,
    fix: `${undeclaredPageTypeSuggestion(pack)} To declare it: gbrain schema add-type ${safeCliToken(parsed.type) ?? '<type>'} (with its primitive and prefix)`,
    docs: 'docs/architecture/schema-packs.md#undeclared-page-types',
  };
  ctx.logger.warn(`[${warning.code}] ${warning.cause} ${warning.fix}`);
  return warning;
}

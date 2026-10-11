/**
 * The question page (`questions/<slug>`): the question, its scope and the
 * owner's own notes. It never holds the generated answer (that lives in
 * pinned_questions, read through freshness.ts), so its chunks, versions, the
 * exported file and git history carry no derived text. Frontmatter
 * `visibility: private` plus the `pinned_question` marker keep it out of
 * every remote read, whatever the owner later edits.
 *
 * Only trusted local callers materialize or archive the page, through the
 * persistence coordinator; a remote pin waits for the owner's next local
 * `gbrain questions` call or cycle.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { Page } from '../types.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { PINNED_QUESTION_MARKER, QUESTION_PAGE_TYPE, normalizeQuestion } from './identity.ts';
import { pinId, pinScope, type PinRow } from './store.ts';

const OWNER_NOTE_MARKER = '<!-- gbrain:pinned-question v1 -->';
export const MAX_OWNER_SENTENCES = 20;
const MAX_OWNER_SENTENCE_CHARS = 500;

export interface QuestionPageState {
  page_id: number;
  generation: number;
  revision: string;
  compiled_truth: string;
  archived: boolean;
}

export async function readQuestionPage(engine: BrainEngine, pin: Pick<PinRow, 'source_id' | 'slug'>): Promise<QuestionPageState | null> {
  const [row] = await engine.executeRaw<{ id: number; generation: string | number; revision: string | null; compiled_truth: string; archived: boolean }>(
    `SELECT id, generation, knowledge_revision::text AS revision, compiled_truth,
       COALESCE(frontmatter->>'status', '') = 'archived' AS archived
     FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [pin.source_id, pin.slug]);
  return row ? { page_id: row.id, generation: Number(row.generation), revision: row.revision ?? '', compiled_truth: row.compiled_truth ?? '', archived: row.archived } : null;
}

/** The owner's claims: every sentence of the page body except the heading and gbrain's comments. */
export function ownerClaims(compiledTruth: string): string[] {
  const body = compiledTruth
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .filter(line => !/^\s*#\s/.test(line))
    .join('\n');
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => normalizeQuestion(s.replace(/^[-*]\s+/, '')))
    .filter(s => s.length > 0)
    .slice(0, MAX_OWNER_SENTENCES)
    .map(s => s.slice(0, MAX_OWNER_SENTENCE_CHARS));
}

function renderPage(pin: PinRow, status: 'pinned' | 'archived', ownerBody: string | null): string {
  const id = pinId(pin);
  const scope = pinScope(pin);
  const page = {
    title: pin.question.slice(0, 200),
    type: QUESTION_PAGE_TYPE,
    compiled_truth: ownerBody ?? [
      `# ${pin.question}`,
      '',
      OWNER_NOTE_MARKER,
      `<!-- Write your own claims about this question below; each sentence is kept in the answer as your claim and goes stale when you edit it until the next refresh. The generated answer is not stored in this file: gbrain questions status ${id} -->`,
      '',
    ].join('\n'),
    timeline: '',
    frontmatter: {
      visibility: 'private',
      [PINNED_QUESTION_MARKER]: id,
      question: pin.question,
      status,
      ...(scope.slug_prefix ? { scope_slug_prefix: scope.slug_prefix } : {}),
      ...(scope.entity ? { scope_entity: scope.entity } : {}),
    },
  } as unknown as Page;
  return serializePageToMarkdown(page, []);
}

function localCtx(ctx: Pick<OperationContext, 'engine' | 'config'>, sourceId: string): OperationContext {
  return { engine: ctx.engine, config: ctx.config, remote: false, sourceId, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
}

/** Brings the page in line with the pin: created when missing, archived or restored with the pin. Trusted local callers only. */
export async function syncQuestionPage(ctx: Pick<OperationContext, 'engine' | 'config' | 'remote'>, pin: PinRow): Promise<'created' | 'archived' | 'restored' | 'unchanged' | 'skipped'> {
  if (ctx.remote !== false) return 'skipped';
  const existing = await readQuestionPage(ctx.engine, pin);
  const wantArchived = pin.state === 'archived';
  if (!existing) {
    if (wantArchived) return 'unchanged';
    await submitPageMutation(localCtx(ctx, pin.source_id), { operation: 'put_page', params: {
      slug: pin.slug, source_id: pin.source_id, content: renderPage(pin, 'pinned', null),
    } });
    return 'created';
  }
  if (existing.archived === wantArchived) return 'unchanged';
  const snapshot = await ctx.engine.readPageSnapshot(pin.slug, { sourceId: pin.source_id });
  if (!snapshot) return 'unchanged';
  await submitPageMutation(localCtx(ctx, pin.source_id), { operation: 'put_page', params: {
    slug: pin.slug, source_id: pin.source_id, expected_revision: snapshot.revision,
    content: renderPage(pin, wantArchived ? 'archived' : 'pinned', snapshot.page.compiled_truth ?? existing.compiled_truth),
  } });
  return wantArchived ? 'archived' : 'restored';
}

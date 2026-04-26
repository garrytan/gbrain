import { createHash, randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type {
  MemoryRedactionPlan,
  MemoryRedactionPlanInput,
  MemoryRedactionPlanItem,
  Page,
} from '../types.ts';
import { contentHash } from '../utils.ts';
import { recordMemoryMutationEvent } from './memory-mutation-ledger-service.ts';
import { hashCanonicalJson } from './target-snapshot-hash-service.ts';

export interface CreateMemoryRedactionPlanServiceInput {
  id?: string;
  scope_id: string;
  query: string;
  replacement_text?: string;
  requested_by?: string | null;
  source_refs?: string[];
}

export interface ReviewMemoryRedactionPlanServiceInput {
  id: string;
  review_reason?: string | null;
}

export interface ApplyMemoryRedactionPlanServiceInput {
  id: string;
  actor?: string;
  source_refs?: string[];
}

const DEFAULT_REPLACEMENT_TEXT = '[REDACTED]';
const DEFAULT_CREATE_SOURCE_REFS = ['Source: mbrain create_memory_redaction_plan operation'];
const DEFAULT_APPLY_SOURCE_REFS = ['Source: mbrain apply_memory_redaction_plan operation'];
const DEFAULT_ACTOR = 'mbrain:redaction_plan_service';
const PAGE_TEXT_FIELDS = ['compiled_truth', 'timeline'] as const;

type PageTextField = typeof PAGE_TEXT_FIELDS[number];

export async function createMemoryRedactionPlan(
  engine: BrainEngine,
  input: CreateMemoryRedactionPlanServiceInput,
): Promise<MemoryRedactionPlan> {
  const planInput = redactionPlanInput(input);
  const sourceRefs = normalizeSourceRefs(input.source_refs, DEFAULT_CREATE_SOURCE_REFS);

  return engine.transaction(async (tx) => {
    const plan = await tx.createMemoryRedactionPlan(planInput);
    const items = await createPagePlanItems(tx, plan);
    await recordMemoryMutationEvent(tx, {
      session_id: plan.id,
      realm_id: plan.scope_id,
      actor: plan.requested_by ?? DEFAULT_ACTOR,
      operation: 'create_redaction_plan',
      target_kind: 'ledger_event',
      target_id: plan.id,
      scope_id: plan.scope_id,
      source_refs: sourceRefs,
      expected_target_snapshot_hash: null,
      current_target_snapshot_hash: hashCanonicalJson(redactionPlanSnapshot(plan, items)),
      result: 'staged_for_review',
      metadata: {
        plan_id: plan.id,
        query: plan.query,
        replacement_text: plan.replacement_text,
        item_count: items.length,
      },
    });
    return plan;
  });
}

export async function approveMemoryRedactionPlan(
  engine: BrainEngine,
  input: ReviewMemoryRedactionPlanServiceInput,
): Promise<MemoryRedactionPlan> {
  const plan = await requireDraftPlan(engine, input.id);
  const reviewedAt = new Date();
  const updated = await engine.updateMemoryRedactionPlanStatus(plan.id, {
    status: 'approved',
    expected_current_status: 'draft',
    review_reason: input.review_reason ?? null,
    reviewed_at: reviewedAt,
  });
  if (!updated) {
    throw new Error(`memory redaction plan was not approved: ${plan.id}`);
  }
  return updated;
}

export async function rejectMemoryRedactionPlan(
  engine: BrainEngine,
  input: ReviewMemoryRedactionPlanServiceInput,
): Promise<MemoryRedactionPlan> {
  const plan = await requireDraftPlan(engine, input.id);
  const reviewedAt = new Date();
  const updated = await engine.updateMemoryRedactionPlanStatus(plan.id, {
    status: 'rejected',
    expected_current_status: 'draft',
    review_reason: input.review_reason ?? null,
    reviewed_at: reviewedAt,
  });
  if (!updated) {
    throw new Error(`memory redaction plan was not rejected: ${plan.id}`);
  }
  return updated;
}

export async function applyMemoryRedactionPlan(
  engine: BrainEngine,
  input: ApplyMemoryRedactionPlanServiceInput,
): Promise<MemoryRedactionPlan> {
  const sourceRefs = normalizeSourceRefs(input.source_refs, DEFAULT_APPLY_SOURCE_REFS);

  return engine.transaction(async (tx) => {
    const plan = await tx.getMemoryRedactionPlan(input.id);
    if (!plan) {
      throw new Error(`memory redaction plan not found: ${input.id}`);
    }
    if (plan.status !== 'approved') {
      throw new Error(`memory redaction plan must be approved before apply: ${plan.id}`);
    }

    const items = await tx.listMemoryRedactionPlanItems({ plan_id: plan.id, limit: 10_000 });
    assertSupportedApplyItems(items);
    const plannedItems = items.filter((item) => item.status === 'planned');
    const itemsByPage = groupPageItems(plannedItems);
    const appliedItemIds: string[] = [];
    const pageIds = [...itemsByPage.keys()].sort();

    for (const pageId of pageIds) {
      const page = await tx.getPageForUpdate(pageId);
      if (!page) {
        throw new Error(`memory redaction page target not found: ${pageId}`);
      }
      const next = applyPageItems(page, plan, itemsByPage.get(pageId) ?? []);
      await tx.putPage(page.slug, {
        type: page.type,
        title: page.title,
        compiled_truth: next.compiled_truth,
        timeline: next.timeline,
        frontmatter: page.frontmatter,
        content_hash: contentHash(next.compiled_truth, next.timeline),
      });
      for (const itemResult of next.itemResults) {
        const updatedItem = await tx.updateMemoryRedactionPlanItemStatus(itemResult.id, {
          status: 'applied',
          expected_current_status: 'planned',
          before_hash: itemResult.before_hash,
          after_hash: itemResult.after_hash,
          updated_at: new Date(),
        });
        if (!updatedItem) {
          throw new Error(`memory redaction plan item was not applied: ${itemResult.id}`);
        }
        appliedItemIds.push(updatedItem.id);
      }
    }

    const appliedAt = new Date();
    const applied = await tx.updateMemoryRedactionPlanStatus(plan.id, {
      status: 'applied',
      expected_current_status: 'approved',
      applied_at: appliedAt,
    });
    if (!applied) {
      throw new Error(`memory redaction plan was not marked applied: ${plan.id}`);
    }

    await recordMemoryMutationEvent(tx, {
      session_id: plan.id,
      realm_id: plan.scope_id,
      actor: input.actor ?? plan.requested_by ?? DEFAULT_ACTOR,
      operation: 'execute_redaction_plan',
      target_kind: 'ledger_event',
      target_id: plan.id,
      scope_id: plan.scope_id,
      source_refs: sourceRefs,
      expected_target_snapshot_hash: hashCanonicalJson(redactionPlanSnapshot(plan, items)),
      current_target_snapshot_hash: hashCanonicalJson(redactionPlanSnapshot(applied, await tx.listMemoryRedactionPlanItems({
        plan_id: plan.id,
        limit: 10_000,
      }))),
      result: 'redacted',
      applied_at: appliedAt,
      metadata: {
        plan_id: plan.id,
        query: plan.query,
        replacement_text: plan.replacement_text,
        applied_item_count: appliedItemIds.length,
        page_count: pageIds.length,
        item_ids: appliedItemIds,
        page_ids: pageIds,
      },
      redaction_visibility: 'partially_redacted',
    });

    return applied;
  });
}

function redactionPlanInput(input: CreateMemoryRedactionPlanServiceInput): MemoryRedactionPlanInput {
  const scopeId = requiredString('scope_id', input.scope_id);
  const query = requiredString('query', input.query);
  if (input.replacement_text !== undefined && typeof input.replacement_text !== 'string') {
    throw new Error('memory redaction replacement_text must be a string');
  }
  return {
    id: input.id ? requiredString('id', input.id) : `redaction-plan:${randomUUID()}`,
    scope_id: scopeId,
    query,
    replacement_text: input.replacement_text ?? DEFAULT_REPLACEMENT_TEXT,
    status: 'draft',
    requested_by: input.requested_by ?? null,
    review_reason: null,
    reviewed_at: null,
    applied_at: null,
  };
}

async function requireDraftPlan(engine: BrainEngine, id: string): Promise<MemoryRedactionPlan> {
  const planId = requiredString('id', id);
  const plan = await engine.getMemoryRedactionPlan(planId);
  if (!plan) {
    throw new Error(`memory redaction plan not found: ${planId}`);
  }
  if (plan.status !== 'draft') {
    throw new Error(`memory redaction plan must be draft for review: ${plan.id}`);
  }
  return plan;
}

async function createPagePlanItems(
  engine: BrainEngine,
  plan: MemoryRedactionPlan,
): Promise<MemoryRedactionPlanItem[]> {
  const items: MemoryRedactionPlanItem[] = [];
  const pages = await listAllPages(engine);
  for (const page of pages.sort((left, right) => left.slug.localeCompare(right.slug))) {
    for (const field of PAGE_TEXT_FIELDS) {
      const text = page[field] ?? '';
      if (!text.includes(plan.query)) continue;
      items.push(await engine.createMemoryRedactionPlanItem({
        id: redactionItemId(plan.id, page.slug, field),
        plan_id: plan.id,
        target_object_type: 'page',
        target_object_id: page.slug,
        field_path: field,
        before_hash: hashText(text),
        after_hash: null,
        status: 'planned',
        preview_text: previewText(text, plan.query),
      }));
    }
  }
  return items;
}

async function listAllPages(engine: BrainEngine): Promise<Page[]> {
  const pages: Page[] = [];
  for (let offset = 0; ; offset += 500) {
    const batch = await engine.listPages({ limit: 500, offset });
    pages.push(...batch);
    if (batch.length < 500) return pages;
  }
}

function assertSupportedApplyItems(items: MemoryRedactionPlanItem[]): void {
  const unsupported = items.find((item) => item.status === 'unsupported');
  if (unsupported) {
    throw new Error(`memory redaction plan contains unsupported item: ${unsupported.id}`);
  }
  const unsupportedPlanned = items.find((item) => item.status === 'planned' && item.target_object_type !== 'page');
  if (unsupportedPlanned) {
    throw new Error(`memory redaction plan item target is unsupported for apply: ${unsupportedPlanned.target_object_type}`);
  }
  const unsupportedField = items.find(
    (item) => item.status === 'planned'
      && item.target_object_type === 'page'
      && !PAGE_TEXT_FIELDS.includes(item.field_path as PageTextField),
  );
  if (unsupportedField) {
    throw new Error(`memory redaction plan item field is unsupported for apply: ${unsupportedField.field_path}`);
  }
}

function groupPageItems(items: MemoryRedactionPlanItem[]): Map<string, MemoryRedactionPlanItem[]> {
  const grouped = new Map<string, MemoryRedactionPlanItem[]>();
  for (const item of items) {
    const existing = grouped.get(item.target_object_id) ?? [];
    existing.push(item);
    grouped.set(item.target_object_id, existing);
  }
  for (const pageItems of grouped.values()) {
    pageItems.sort((left, right) => left.field_path.localeCompare(right.field_path));
  }
  return grouped;
}

function applyPageItems(
  page: Page,
  plan: MemoryRedactionPlan,
  items: MemoryRedactionPlanItem[],
): {
  compiled_truth: string;
  timeline: string;
  itemResults: Array<{ id: string; before_hash: string; after_hash: string }>;
} {
  let compiledTruth = page.compiled_truth;
  let timeline = page.timeline;
  const itemResults: Array<{ id: string; before_hash: string; after_hash: string }> = [];

  for (const item of items) {
    const field = item.field_path as PageTextField;
    const beforeText = field === 'compiled_truth' ? compiledTruth : timeline;
    const afterText = replaceAllLiteral(beforeText, plan.query, plan.replacement_text);
    if (field === 'compiled_truth') {
      compiledTruth = afterText;
    } else {
      timeline = afterText;
    }
    itemResults.push({
      id: item.id,
      before_hash: hashText(beforeText),
      after_hash: hashText(afterText),
    });
  }

  return {
    compiled_truth: compiledTruth,
    timeline,
    itemResults,
  };
}

function redactionPlanSnapshot(
  plan: MemoryRedactionPlan,
  items: MemoryRedactionPlanItem[],
): Record<string, unknown> {
  return {
    id: plan.id,
    scope_id: plan.scope_id,
    query: plan.query,
    replacement_text: plan.replacement_text,
    status: plan.status,
    requested_by: plan.requested_by,
    review_reason: plan.review_reason,
    reviewed_at: plan.reviewed_at,
    applied_at: plan.applied_at,
    item_ids: items.map((item) => item.id).sort(),
    item_statuses: Object.fromEntries(items.map((item) => [item.id, item.status]).sort()),
  };
}

function redactionItemId(planId: string, pageSlug: string, field: string): string {
  return `redaction-item:${hashText(`${planId}\0${pageSlug}\0${field}`).slice(0, 32)}`;
}

function previewText(text: string, query: string): string {
  const index = text.indexOf(query);
  if (index < 0) return '';
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + query.length + 40);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function replaceAllLiteral(text: string, query: string, replacement: string): string {
  return text.split(query).join(replacement);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function requiredString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`memory redaction plan ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeSourceRefs(input: string[] | undefined, defaultValue: string[]): string[] {
  if (input === undefined) return [...defaultValue];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('memory redaction source_refs must contain at least one provenance reference');
  }
  return input.map((sourceRef, index) => {
    if (typeof sourceRef !== 'string' || sourceRef.trim().length === 0) {
      throw new Error(`memory redaction source_refs[${index}] must be a non-empty string`);
    }
    return sourceRef.trim();
  });
}

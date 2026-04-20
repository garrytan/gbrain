import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildActionDraftContextSource,
  type ActionDraftContextSourceResult,
  type ActionDraftContextThreadMessage,
} from '../../src/action-brain/context.ts';
import {
  generateActionDraft,
  type DraftGenerationContext,
} from '../../src/action-brain/draft-generator.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ActionType } from '../../src/action-brain/types.ts';

interface ThreadMessage {
  sender: string;
  ts: string;
  text: string;
}

interface GBrainPage {
  slug: string;
  compiled_truth: string;
}

interface DraftExpected {
  must_include_any: string[];
  must_not_include_any: string[];
  max_chars: number;
  tone: string;
}

interface DraftGoldSetActionItem {
  id: number;
  title: string;
  type: ActionType;
  owner: string;
  waiting_on: string | null;
  source_contact: string;
}

interface DraftGoldSetRow {
  id: string;
  action_item: DraftGoldSetActionItem;
  gbrain_pages: GBrainPage[];
  thread: ThreadMessage[];
  expected: DraftExpected;
  deterministic_draft: string;
}

interface FakeResponse {
  content: Array<{ type: 'text'; text: string }>;
}

const CHECKED_IN_DRAFT_GOLD_SET_PATH = resolve(import.meta.dir, 'fixtures/draft-gold-set.jsonl');
const PRIVATE_DRAFT_GOLD_SET_PATH = process.env.ACTION_BRAIN_PRIVATE_DRAFT_GOLD_SET_PATH;
const DETERMINISTIC_MODEL = 'deterministic-draft-gold-set';
const ACTION_TYPES = new Set<ActionType>(['commitment', 'follow_up', 'decision', 'question', 'delegation']);

class DeterministicDraftGoldSetClient {
  public readonly calls: Array<{ caseId: string; itemId: number; model: string; prompt: string }> = [];
  private readonly rowsByItemId: Map<number, DraftGoldSetRow>;

  constructor(
    rows: DraftGoldSetRow[],
    private readonly options: { corruptRowIds?: string[] } = {}
  ) {
    this.rowsByItemId = new Map(rows.map((row) => [row.action_item.id, row]));
  }

  messages = {
    create: async (params: { model: string; messages: Array<{ content: string }> }): Promise<FakeResponse> => {
      const prompt = params.messages[0]?.content ?? '';
      const itemId = extractActionItemId(prompt);
      const row = this.rowsByItemId.get(itemId);

      if (!row) {
        throw new Error(`No deterministic draft gold-set fixture row for item ${itemId}`);
      }

      this.calls.push({ caseId: row.id, itemId, model: params.model, prompt });

      const shouldCorrupt = this.options.corruptRowIds?.includes(row.id) ?? false;
      const draftText = shouldCorrupt ? row.action_item.title : row.deterministic_draft;

      return {
        content: [{ type: 'text', text: draftText }],
      };
    },
  };
}

function loadDraftGoldSet(path: string): DraftGoldSetRow[] {
  const raw = readFileSync(path, 'utf8');
  const rows: DraftGoldSetRow[] = [];

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = JSON.parse(trimmed) as Partial<DraftGoldSetRow>;
    if (
      !parsed.id
      || !parsed.action_item
      || !parsed.expected
      || !Array.isArray(parsed.thread)
      || !Array.isArray(parsed.gbrain_pages)
      || typeof parsed.deterministic_draft !== 'string'
    ) {
      throw new Error(`Invalid draft gold-set row at line ${index + 1}`);
    }

    const expected = parsed.expected as Partial<DraftExpected>;
    if (
      !Array.isArray(expected.must_include_any)
      || !Array.isArray(expected.must_not_include_any)
      || typeof expected.max_chars !== 'number'
      || expected.max_chars <= 0
      || typeof expected.tone !== 'string'
      || expected.tone.length === 0
    ) {
      throw new Error(`Invalid expected contract in draft gold-set row at line ${index + 1}`);
    }

    const actionItem = parsed.action_item as Partial<DraftGoldSetActionItem>;
    if (
      typeof actionItem.id !== 'number'
      || !Number.isFinite(actionItem.id)
      || !actionItem.title
      || typeof actionItem.source_contact !== 'string'
      || actionItem.source_contact.length === 0
    ) {
      throw new Error(`Invalid action_item contract in draft gold-set row at line ${index + 1}`);
    }

    rows.push({
      ...parsed,
      action_item: {
        id: actionItem.id,
        title: actionItem.title,
        type: normalizeActionType(actionItem.type),
        owner: typeof actionItem.owner === 'string' ? actionItem.owner : 'Abhi',
        waiting_on: typeof actionItem.waiting_on === 'string' ? actionItem.waiting_on : null,
        source_contact: actionItem.source_contact,
      },
    } as DraftGoldSetRow);
  }

  return rows;
}

function normalizeActionType(value: unknown): ActionType {
  return typeof value === 'string' && ACTION_TYPES.has(value as ActionType)
    ? value as ActionType
    : 'commitment';
}

function extractActionItemId(prompt: string): number {
  const match = prompt.match(/<item>[\s\S]*?"id"\s*:\s*(\d+)[\s\S]*?<\/item>/i);
  if (!match) {
    throw new Error(`Could not extract action item id from prompt: ${prompt}`);
  }
  return Number(match[1]);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

function hasPromptTagEcho(text: string): boolean {
  return /<\/?(system|gbrain_context|action_item|item|thread|task)\b/i.test(text);
}

function toContextThreadMessages(thread: ThreadMessage[]): ActionDraftContextThreadMessage[] {
  return thread.map((message) => ({
    sender: message.sender,
    ts: message.ts,
    text: message.text,
  }));
}

function mutateThread(thread: ThreadMessage[]): ActionDraftContextThreadMessage[] {
  if (thread.length === 0) {
    return [{
      sender: 'system',
      ts: '2026-04-20T00:00:00Z',
      text: 'mutation marker',
    }];
  }

  return thread.map((message, index) => ({
    sender: message.sender,
    ts: message.ts,
    text: index === thread.length - 1
      ? `${message.text} [hash-mutation]`
      : message.text,
  }));
}

function createContextEngine(row: DraftGoldSetRow): BrainEngine {
  const pagesBySlug = new Map(row.gbrain_pages.map((page) => [page.slug, page.compiled_truth]));

  return {
    searchKeyword: async () => row.gbrain_pages.map((page) => ({ slug: page.slug })),
    getPage: async (slug: string) => {
      const compiledTruth = pagesBySlug.get(slug);
      if (!compiledTruth) {
        return null as any;
      }
      return { compiled_truth: compiledTruth } as any;
    },
  } as BrainEngine;
}

async function buildContextForRow(
  row: DraftGoldSetRow,
  threadMessages: ActionDraftContextThreadMessage[]
): Promise<ActionDraftContextSourceResult> {
  return buildActionDraftContextSource(
    createContextEngine(row),
    {
      source_contact: row.action_item.source_contact,
      source_thread: `${row.id}-thread`,
    },
    { threadMessages }
  );
}

function toDraftGenerationContext(context: ActionDraftContextSourceResult): DraftGenerationContext {
  return {
    gbrainPages: context.excerpts.map((excerpt) => ({
      slug: excerpt.slug,
      compiled_truth: excerpt.text,
    })),
    threadMessages: context.thread.map((message) => ({
      sender: message.sender,
      ts: message.ts,
      text: message.text,
    })),
  };
}

function validateStructuralContract(row: DraftGoldSetRow, draftText: string): string[] {
  const errors: string[] = [];

  if (draftText.trim().length === 0) {
    errors.push('empty_draft');
  }

  if (draftText.length > row.expected.max_chars) {
    errors.push('max_chars_exceeded');
  }

  const hasIncludeMatch = row.expected.must_include_any.some((term) => includesCaseInsensitive(draftText, term));
  if (!hasIncludeMatch) {
    errors.push('must_include_missing');
  }

  const forbiddenHit = row.expected.must_not_include_any.some((term) => includesCaseInsensitive(draftText, term));
  if (forbiddenHit) {
    errors.push('must_not_include_hit');
  }

  if (hasPromptTagEcho(draftText)) {
    errors.push('prompt_tag_echo');
  }

  if (normalizeText(draftText) === normalizeText(row.action_item.title)) {
    errors.push('title_echo');
  }

  return errors;
}

async function computeStructuralMetrics(
  rows: DraftGoldSetRow[],
  options: { corruptRowIds?: string[] } = {}
): Promise<{
  totalCases: number;
  passedCases: number;
  failedCases: number;
  structuralPassRate: number;
  generationCalls: number;
  failures: Array<{ id: string; reasons: string[] }>;
}> {
  const deterministicClient = new DeterministicDraftGoldSetClient(rows, options);
  const failures: Array<{ id: string; reasons: string[] }> = [];
  let passedCases = 0;

  for (const row of rows) {
    const firstContext = await buildContextForRow(row, toContextThreadMessages(row.thread));
    const secondContext = await buildContextForRow(row, toContextThreadMessages(row.thread));
    const mutatedContext = await buildContextForRow(row, mutateThread(row.thread));

    const firstResult = await generateActionDraft(
      {
        id: row.action_item.id,
        title: row.action_item.title,
        type: row.action_item.type,
        status: 'open',
        owner: row.action_item.owner,
        waiting_on: row.action_item.waiting_on,
        due_at: null,
        source_contact: row.action_item.source_contact,
      },
      toDraftGenerationContext(firstContext),
      {
        client: deterministicClient,
        model: DETERMINISTIC_MODEL,
        ownerName: row.action_item.owner,
      }
    );

    const secondResult = await generateActionDraft(
      {
        id: row.action_item.id,
        title: row.action_item.title,
        type: row.action_item.type,
        status: 'open',
        owner: row.action_item.owner,
        waiting_on: row.action_item.waiting_on,
        due_at: null,
        source_contact: row.action_item.source_contact,
      },
      toDraftGenerationContext(secondContext),
      {
        client: deterministicClient,
        model: DETERMINISTIC_MODEL,
        ownerName: row.action_item.owner,
      }
    );

    const reasons: string[] = [];

    if (firstContext.context_hash !== secondContext.context_hash) {
      reasons.push('context_hash_unstable');
    }
    if (firstContext.context_hash === mutatedContext.context_hash) {
      reasons.push('context_hash_mutation_not_detected');
    }

    if (!firstResult.ok || !secondResult.ok) {
      reasons.push('draft_generation_failed');
    } else {
      reasons.push(...validateStructuralContract(row, firstResult.draftText));

      if (firstResult.injectionSuspected || secondResult.injectionSuspected) {
        reasons.push('injection_suspected');
      }
      if (firstResult.draftText !== secondResult.draftText) {
        reasons.push('deterministic_output_mismatch');
      }
    }

    if (reasons.length === 0) {
      passedCases += 1;
    } else {
      failures.push({ id: row.id, reasons });
    }
  }

  const totalCases = rows.length;
  const failedCases = totalCases - passedCases;
  const structuralPassRate = totalCases === 0 ? 1 : passedCases / totalCases;

  return {
    totalCases,
    passedCases,
    failedCases,
    structuralPassRate,
    generationCalls: deterministicClient.calls.length,
    failures,
  };
}

describe('action-brain draft-quality checked-in gold set gate', () => {
  test('loads the checked-in draft gold-set JSONL fixture', () => {
    const rows = loadDraftGoldSet(CHECKED_IN_DRAFT_GOLD_SET_PATH);
    expect(rows.length).toBeGreaterThanOrEqual(15);

    const expectedChecks = rows.reduce(
      (sum, row) => sum + row.expected.must_include_any.length + row.expected.must_not_include_any.length,
      0
    );
    expect(expectedChecks).toBeGreaterThan(0);
  });

  test('enforces >=90% structural pass rate on the checked-in evaluation set', async () => {
    const rows = loadDraftGoldSet(CHECKED_IN_DRAFT_GOLD_SET_PATH);
    const metrics = await computeStructuralMetrics(rows);

    console.log(
      `[draft-gold-set] total=${metrics.totalCases} passed=${metrics.passedCases} failed=${metrics.failedCases} ` +
      `structural_pass_rate=${metrics.structuralPassRate.toFixed(3)}`
    );

    expect(metrics.generationCalls).toBe(rows.length * 2);
    // CI gate for GIT-1064: fail the unit lane when structural pass rate drops below 90%.
    expect(metrics.structuralPassRate).toBeGreaterThanOrEqual(0.9);
  });

  test('fails the gate when deterministic output regresses to title echo on two rows', async () => {
    const rows = loadDraftGoldSet(CHECKED_IN_DRAFT_GOLD_SET_PATH);
    expect(rows.length).toBeGreaterThanOrEqual(15);

    const corruptRowIds = [rows[0].id, rows[1].id];
    const metrics = await computeStructuralMetrics(rows, { corruptRowIds });

    expect(metrics.structuralPassRate).toBeLessThan(0.9);
  });

  test('validates private draft gold-set contract when ACTION_BRAIN_PRIVATE_DRAFT_GOLD_SET_PATH is set', () => {
    if (!PRIVATE_DRAFT_GOLD_SET_PATH) {
      expect(true).toBe(true);
      return;
    }

    const privateRows = loadDraftGoldSet(PRIVATE_DRAFT_GOLD_SET_PATH);
    expect(privateRows.length).toBeGreaterThanOrEqual(50);

    const maxCharsCheck = privateRows.every((row) => row.expected.max_chars > 0);
    expect(maxCharsCheck).toBe(true);
  });
});

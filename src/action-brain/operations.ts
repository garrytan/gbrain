import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BrainEngine } from '../core/engine.ts';
import type { Operation } from '../core/operations.ts';
import { ActionEngine, ActionItemNotFoundError, ActionTransitionError } from './action-engine.ts';
import { MorningBriefGenerator } from './brief.ts';
import {
  createEmptyExtractionRunSummary,
  extractCommitmentsWithSummary,
  HAIKU_MODEL,
  type StructuredCommitment,
  type WhatsAppMessage,
} from './extractor.ts';
import type { ActionDraft, ActionDraftStatus, ActionItem } from './types.ts';
import { initActionSchema } from './action-schema.ts';

interface QueryResult<T> {
  rows: T[];
}

interface QueryableDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec?: (sql: string) => Promise<unknown>;
  transaction?: <T>(fn: (txDb: QueryableDb) => Promise<T>) => Promise<T>;
}

interface PostgresUnsafeConnection {
  unsafe: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  begin?: <T>(fn: (tx: PostgresUnsafeConnection) => Promise<T>) => Promise<T>;
}

const STATUS_VALUES = ['open', 'waiting_on', 'in_progress', 'stale', 'resolved', 'dropped'] as const;
const ACTION_DRAFT_STATUS_VALUES = ['pending', 'approved', 'rejected', 'sent', 'send_failed', 'superseded'] as const;
const ACTION_LIST_FILTER_VALUES = ['low_confidence_dropped'] as const;
const LOW_CONFIDENCE_THRESHOLD = 0.9;
const SOURCE_EXCERPT_MAX_CHARS = 500;
const ACTION_EXTRACTOR_VERSION = 'extractor.ts@v1';
const ACTION_DRAFT_DEFAULT_SEND_TIMEOUT_MS = 30_000;
const ACTION_DRAFT_DEFAULT_MODEL = 'manual';
const ENTITY_LINK_SEARCH_LIMIT = 20;
export const ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CONCURRENCY = 4;
export const ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CAP = 24;
const execFileAsync = promisify(execFile);
const initializedEngines = new WeakSet<object>();
const postgresDbCache = new WeakMap<object, QueryableDb>();
type ActionListFilter = typeof ACTION_LIST_FILTER_VALUES[number];
type ActionDraftStatusValue = typeof ACTION_DRAFT_STATUS_VALUES[number];
type ActionDropReason = 'low_confidence' | 'schema_reject' | 'duplicate' | 'other';

interface ActionDropRow {
  id: number;
  run_id: string;
  source_id: string;
  source_excerpt: string;
  drop_reason: ActionDropReason;
  confidence: number;
  extractor_version: string;
  model: string;
  created_at: Date | string;
}

interface ActionDrop {
  id: number;
  run_id: string;
  source_id: string;
  source_excerpt: string;
  drop_reason: ActionDropReason;
  confidence: number;
  extractor_version: string;
  model: string;
  created_at: Date;
}

interface ListActionDropFilters {
  dropReason?: ActionDropReason;
  limit?: number;
  offset?: number;
}

interface ActionDraftListRow {
  id: number;
  action_item_id: number;
  version: number;
  status: ActionDraftStatus;
  channel: string;
  recipient: string;
  draft_text: string;
  model: string;
  context_hash: string;
  context_snapshot: Record<string, unknown> | string;
  generated_at: Date | string;
  approved_at: Date | string | null;
  sent_at: Date | string | null;
  send_error: string | null;
  action_priority_score: number;
  action_status: string;
  action_title: string;
}

interface ActionDraftStateRow {
  id: number;
  action_item_id: number;
  status: ActionDraftStatus;
  channel: string;
  recipient: string;
  draft_text: string;
  approved_at: Date | string | null;
  sent_at: Date | string | null;
}

interface ActionDraftRow {
  id: number;
  action_item_id: number;
  version: number;
  status: ActionDraftStatus;
  channel: string;
  recipient: string;
  draft_text: string;
  model: string;
  context_hash: string;
  context_snapshot: Record<string, unknown> | string;
  generated_at: Date | string;
  approved_at: Date | string | null;
  sent_at: Date | string | null;
  send_error: string | null;
}

interface ActionItemDraftSeedRow {
  id: number;
  title: string;
  source_contact: string;
}

interface SendCommandResult {
  stdout: string;
  stderr: string;
}

type SendTextExecutor = (
  command: string,
  args: string[],
  options: { timeoutMs: number }
) => Promise<SendCommandResult>;

let sendTextExecutor: SendTextExecutor = defaultSendTextExecutor;

export function setActionDraftSendExecutorForTests(executor: SendTextExecutor | null): void {
  sendTextExecutor = executor ?? defaultSendTextExecutor;
}

export const actionBrainOperations: Operation[] = [
  {
    name: 'action_list',
    description: 'List Action Brain items with optional filters',
    params: {
      status: { type: 'string', enum: [...STATUS_VALUES], description: 'Filter by lifecycle status' },
      owner: { type: 'string', description: 'Filter by owner' },
      stale: { type: 'boolean', description: 'Filter by stale state' },
      filter: {
        type: 'string',
        enum: [...ACTION_LIST_FILTER_VALUES],
        description: 'Filter by derived audit views (example: low_confidence_dropped)',
      },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      offset: { type: 'number', description: 'Pagination offset (default: 0)' },
    },
    cliHints: { name: 'action-list' },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const engine = new ActionEngine(db);
      const stale = parseOptionalBoolean(p.stale);
      const filter = parseActionListFilter(p.filter);
      const limit = asOptionalNumber(p.limit);
      const offset = asOptionalNumber(p.offset);

      if (filter === 'low_confidence_dropped') {
        return listActionDrops(db, {
          dropReason: 'low_confidence',
          limit,
          offset,
        });
      }

      return engine.listItems({
        status: p.status as any,
        owner: asOptionalNonEmptyString(p.owner) ?? undefined,
        stale,
        limit,
        offset,
      });
    },
  },
  {
    name: 'action_brief',
    description: 'Generate Action Brain morning brief',
    params: {
      now: { type: 'string', description: 'Optional clock override (ISO timestamp)' },
      last_sync_at: { type: 'string', description: 'Override wacli freshness timestamp (ISO timestamp)' },
      timezone_offset_minutes: {
        type: 'number',
        description: 'Timezone offset in minutes east of UTC for due-today classification',
      },
    },
    cliHints: { name: 'action-brief' },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const generator = new MorningBriefGenerator(db);

      const brief = await generator.generateMorningBrief({
        now: parseOptionalDate(p.now, 'now') ?? undefined,
        lastSyncAt: parseOptionalDate(p.last_sync_at, 'last_sync_at'),
        timezoneOffsetMinutes: asOptionalNumber(p.timezone_offset_minutes),
        sourceContactEnricher: async (items) => buildSourceContactLinks(ctx.engine, items),
      });

      return { brief };
    },
  },
  {
    name: 'action_resolve',
    description: 'Mark an Action Brain item as resolved',
    params: {
      id: { type: 'number', required: true, description: 'Action item id' },
      actor: { type: 'string', description: 'Actor writing the status transition' },
    },
    mutating: true,
    cliHints: { name: 'action-resolve', positional: ['id'] },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const engine = new ActionEngine(db);
      const id = asRequiredInteger(p.id, 'id');

      if (ctx.dryRun) {
        return { dry_run: true, action: 'action_resolve', id };
      }

      try {
        const item = await engine.resolveItem(id, { actor: asOptionalNonEmptyString(p.actor) ?? 'system' });
        return { status: 'resolved', item };
      } catch (error) {
        if (error instanceof ActionItemNotFoundError || error instanceof ActionTransitionError) {
          throw new Error(error.message);
        }
        throw error;
      }
    },
  },
  {
    name: 'action_mark_fp',
    description: 'Mark an Action Brain item as false-positive extraction',
    params: {
      id: { type: 'number', required: true, description: 'Action item id' },
      actor: { type: 'string', description: 'Actor writing the status transition' },
    },
    mutating: true,
    cliHints: { name: 'action-mark-fp', positional: ['id'] },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const engine = new ActionEngine(db);
      const id = asRequiredInteger(p.id, 'id');

      if (ctx.dryRun) {
        return { dry_run: true, action: 'action_mark_fp', id };
      }

      try {
        const item = await engine.updateItemStatus(id, 'dropped', {
          actor: asOptionalNonEmptyString(p.actor) ?? 'human_feedback',
          metadata: { reason: 'false_positive' },
        });
        return { status: 'marked_false_positive', item };
      } catch (error) {
        if (error instanceof ActionItemNotFoundError || error instanceof ActionTransitionError) {
          throw new Error(error.message);
        }
        throw error;
      }
    },
  },
  {
    name: 'action_draft_list',
    description: 'List Action Brain drafts',
    params: {
      status: { type: 'string', enum: [...ACTION_DRAFT_STATUS_VALUES], description: 'Filter by draft status' },
      action_item_id: { type: 'number', description: 'Filter by parent action item id' },
      limit: { type: 'number', description: 'Max results (default: 100)' },
      offset: { type: 'number', description: 'Pagination offset (default: 0)' },
    },
    cliHints: { name: 'action-draft-list' },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const status = parseActionDraftStatus(p.status) ?? 'pending';
      const actionItemId = asOptionalInteger(p.action_item_id, 'action_item_id');
      const limit = asOptionalNumber(p.limit);
      const offset = asOptionalNumber(p.offset);
      return listActionDrafts(db, {
        status,
        actionItemId,
        limit,
        offset,
      });
    },
  },
  {
    name: 'action_draft_show',
    description: 'Show one Action Brain draft',
    params: {
      id: { type: 'number', required: true, description: 'Draft id' },
    },
    cliHints: { name: 'action-draft-show', positional: ['id'] },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const engine = new ActionEngine(db);
      const id = asRequiredInteger(p.id, 'id');
      const draft = await engine.getDraft(id);
      if (!draft) {
        throw new Error(`Action draft not found: ${id}`);
      }
      return draft;
    },
  },
  {
    name: 'action_draft_approve',
    description: 'Approve and send one Action Brain draft',
    params: {
      id: { type: 'number', required: true, description: 'Draft id' },
      actor: { type: 'string', description: 'Actor writing lifecycle events' },
      timeout_ms: { type: 'number', description: 'wacli send timeout in milliseconds (default: 30000)' },
      retry: {
        type: 'boolean',
        description: 'When true, resume interrupted approved drafts and retry send_failed drafts',
      },
    },
    mutating: true,
    cliHints: { name: 'action-draft-approve', positional: ['id'] },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const id = asRequiredInteger(p.id, 'id');
      const actor = asOptionalNonEmptyString(p.actor) ?? 'human_feedback';
      const timeoutMs = asOptionalInteger(p.timeout_ms, 'timeout_ms') ?? ACTION_DRAFT_DEFAULT_SEND_TIMEOUT_MS;
      const retry = parseOptionalBoolean(p.retry) ?? false;
      if (timeoutMs <= 0) {
        throw new Error('Invalid timeout_ms: expected integer > 0');
      }

      if (ctx.dryRun) {
        return { dry_run: true, action: 'action_draft_approve', id, timeout_ms: timeoutMs, retry };
      }

      const claimed = await withDbTransaction(db, async (txDb) => {
        const current = await getActionDraftStateForUpdate(txDb, id);
        if (!current) {
          throw new Error(`Action draft not found: ${id}`);
        }

        if (current.status === 'approved' && current.sent_at === null && retry) {
          const hasDeliveryConfirmation = await hasDraftDeliveryConfirmation(
            txDb,
            current.action_item_id,
            current.id
          );
          return {
            claimed: true as const,
            resumedFromStatus: 'approved' as const,
            draft: current,
            reconcileWithoutResend: hasDeliveryConfirmation,
          };
        }

        if (current.status === 'send_failed' && retry) {
          const retried = await reopenFailedDraftForRetry(txDb, id);
          if (!retried) {
            const latest = await getActionDraftStateForUpdate(txDb, id);
            return {
              claimed: false as const,
              resumedFromStatus: null,
              draft: latest ?? current,
              reconcileWithoutResend: false as const,
            };
          }

          return {
            claimed: true as const,
            resumedFromStatus: 'send_failed' as const,
            draft: retried,
            reconcileWithoutResend: false as const,
          };
        }

        if (current.status !== 'pending') {
          return {
            claimed: false as const,
            resumedFromStatus: null,
            draft: current,
            reconcileWithoutResend: false as const,
          };
        }

        const approved = await markDraftApproved(txDb, id);
        if (!approved) {
          const latest = await getActionDraftStateForUpdate(txDb, id);
          return {
            claimed: false as const,
            resumedFromStatus: null,
            draft: latest ?? current,
            reconcileWithoutResend: false as const,
          };
        }

        await insertActionHistory(txDb, approved.action_item_id, 'draft_approved', actor, {
          draft_id: approved.id,
          channel: approved.channel,
          recipient: approved.recipient,
        });

        return {
          claimed: true as const,
          resumedFromStatus: null,
          draft: approved,
          reconcileWithoutResend: false as const,
        };
      });

      if (!claimed.claimed) {
        const retryRequired = claimed.draft.status === 'approved' || claimed.draft.status === 'send_failed';
        return {
          status: 'already_processed',
          draft_id: claimed.draft.id,
          draft_status: claimed.draft.status,
          approved_at: toOptionalDate(claimed.draft.approved_at),
          sent_at: toOptionalDate(claimed.draft.sent_at),
          retry_required: retryRequired,
          retry_hint: retryRequired ? 'rerun with retry=true to resume delivery' : undefined,
        };
      }

      const approvedDraft = claimed.draft;
      const resumedFromStatus = claimed.resumedFromStatus;

      if (claimed.reconcileWithoutResend) {
        const reconciledDraft = await persistDraftSentState(db, id);
        return {
          status: 'sent',
          draft: mapActionDraftRecord(reconciledDraft),
          resumed_from_status: resumedFromStatus,
          reconciled_without_resend: true,
        };
      }

      try {
        await sendDraftViaWacli(approvedDraft.recipient, approvedDraft.draft_text, timeoutMs);
      } catch (error) {
        const sendError = formatError(error);
        const failedDraft = await withDbTransaction(db, async (txDb) => {
          const updated = await updateDraftSendFailed(txDb, id, sendError);
          if (!updated) {
            throw new Error(`Action draft not found: ${id}`);
          }
          await insertActionHistory(txDb, updated.action_item_id, 'draft_send_failed', actor, {
            draft_id: updated.id,
            error: sendError,
            resumed_from_status: resumedFromStatus,
          });
          return updated;
        });

        return {
          status: 'send_failed',
          draft: mapActionDraftRecord(failedDraft),
          resumed_from_status: resumedFromStatus,
        };
      }

      await recordDraftDeliveryConfirmation(db, approvedDraft.action_item_id, approvedDraft.id, actor, resumedFromStatus);
      const sentDraft = await persistDraftSentState(db, id);

      return {
        status: 'sent',
        draft: mapActionDraftRecord(sentDraft),
        resumed_from_status: resumedFromStatus,
      };
    },
  },
  {
    name: 'action_draft_reject',
    description: 'Reject one Action Brain draft',
    params: {
      id: { type: 'number', required: true, description: 'Draft id' },
      reason: { type: 'string', description: 'Optional rejection reason' },
      actor: { type: 'string', description: 'Actor writing lifecycle events' },
    },
    mutating: true,
    cliHints: { name: 'action-draft-reject', positional: ['id'] },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const id = asRequiredInteger(p.id, 'id');
      const reason = asOptionalNonEmptyString(p.reason);
      const actor = asOptionalNonEmptyString(p.actor) ?? 'human_feedback';

      if (ctx.dryRun) {
        return { dry_run: true, action: 'action_draft_reject', id, reason };
      }

      const result = await withDbTransaction(db, async (txDb) => {
        const current = await getActionDraftStateForUpdate(txDb, id);
        if (!current) {
          throw new Error(`Action draft not found: ${id}`);
        }

        if (current.status !== 'pending') {
          return {
            status: 'already_processed',
            draft: mapActionDraftState(current),
          };
        }

        const rejected = await updateDraftRejected(txDb, id);
        if (!rejected) {
          throw new Error(`Action draft not found: ${id}`);
        }

        await insertActionHistory(txDb, rejected.action_item_id, 'draft_rejected', actor, {
          draft_id: rejected.id,
          reason,
        });

        return {
          status: 'rejected',
          draft: mapActionDraftRecord(rejected),
        };
      });

      return result;
    },
  },
  {
    name: 'action_draft_edit',
    description: 'Edit draft text for one Action Brain draft',
    params: {
      id: { type: 'number', required: true, description: 'Draft id' },
      text: { type: 'string', required: true, description: 'Replacement draft text' },
      actor: { type: 'string', description: 'Actor writing lifecycle events' },
    },
    mutating: true,
    cliHints: { name: 'action-draft-edit', positional: ['id'] },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const id = asRequiredInteger(p.id, 'id');
      const actor = asOptionalNonEmptyString(p.actor) ?? 'human_feedback';
      const nextText = asOptionalNonEmptyString(p.text);
      if (!nextText) {
        throw new Error('Missing --text (non-empty draft text required).');
      }

      if (ctx.dryRun) {
        return { dry_run: true, action: 'action_draft_edit', id, text_length: nextText.length };
      }

      const result = await withDbTransaction(db, async (txDb) => {
        const current = await getActionDraftStateForUpdate(txDb, id);
        if (!current) {
          throw new Error(`Action draft not found: ${id}`);
        }
        if (current.status !== 'pending') {
          throw new Error(`Cannot edit draft ${id}: status is ${current.status}. Only pending drafts are editable.`);
        }

        const edited = await updateDraftText(txDb, id, nextText);
        if (!edited) {
          throw new Error(`Action draft not found: ${id}`);
        }

        await insertActionHistory(txDb, edited.action_item_id, 'draft_edited', actor, {
          draft_id: edited.id,
          previous_length: current.draft_text.length,
          new_length: nextText.length,
          diff_length: nextText.length - current.draft_text.length,
        });

        return edited;
      });

      return {
        status: 'edited',
        draft: mapActionDraftRecord(result),
      };
    },
  },
  {
    name: 'action_draft_regenerate',
    description: 'Regenerate a draft for one Action Brain item',
    params: {
      item_id: { type: 'number', required: true, description: 'Action item id' },
      hint: { type: 'string', description: 'Optional regeneration hint' },
      actor: { type: 'string', description: 'Actor writing lifecycle events' },
    },
    mutating: true,
    cliHints: { name: 'action-draft-regenerate', positional: ['item_id'] },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const itemId = asRequiredInteger(p.item_id, 'item_id');
      const hint = asOptionalNonEmptyString(p.hint);
      const actor = asOptionalNonEmptyString(p.actor) ?? 'human_feedback';

      if (ctx.dryRun) {
        return { dry_run: true, action: 'action_draft_regenerate', item_id: itemId, hint };
      }

      const result = await withDbTransaction(db, async (txDb) => {
        const item = await lockActionItemForDraft(txDb, itemId);
        if (!item) {
          throw new Error(`Action item not found: ${itemId}`);
        }

        const supersededIds = await supersedePendingDrafts(txDb, itemId);
        const latestDraft = await getLatestDraftForItem(txDb, itemId);
        const recipient = latestDraft?.recipient ?? resolveRecipientForRegeneratedDraft(item);
        if (!recipient) {
          throw new Error(`Cannot regenerate draft for action item ${itemId}: recipient is unavailable.`);
        }

        const draftText = buildRegeneratedDraftText(item, latestDraft, hint);
        const contextSnapshot = buildRegeneratedContextSnapshot(item, latestDraft, hint);
        const contextHash = hashContextSnapshot(contextSnapshot);
        const inserted = await insertRegeneratedDraft(txDb, {
          actionItemId: item.id,
          recipient,
          draftText,
          model: latestDraft?.model ?? ACTION_DRAFT_DEFAULT_MODEL,
          contextHash,
          contextSnapshot,
        });

        await insertActionHistory(txDb, item.id, 'draft_created', actor, {
          draft_id: inserted.id,
          version: inserted.version,
          regenerated: true,
          hint,
          superseded_draft_ids: supersededIds,
        });

        return {
          draft: inserted,
          superseded_count: supersededIds.length,
        };
      });

      return {
        status: 'regenerated',
        draft: mapActionDraftRecord(result.draft),
        superseded_count: result.superseded_count,
      };
    },
  },
  {
    name: 'action_ingest',
    description: 'Run extraction on a WhatsApp message batch and upsert Action Brain items',
    params: {
      messages: {
        type: 'array',
        description: 'WhatsApp message batch [{ChatName, SenderName, Timestamp, Text, MsgID}]',
        items: { type: 'object' },
      },
      messages_json: { type: 'string', description: 'JSON-encoded WhatsApp message batch (CLI-friendly)' },
      commitments: { type: 'array', description: 'Optional pre-extracted commitments (bypass LLM)', items: { type: 'object' } },
      model: { type: 'string', description: 'Anthropic model override' },
      timeout_ms: { type: 'number', description: 'Extractor timeout in milliseconds' },
      min_confidence: {
        type: 'number',
        description: 'Drop extracted commitments below this confidence threshold (0-1, default: 0)',
      },
      actor: { type: 'string', description: 'Actor writing created events' },
    },
    mutating: true,
    cliHints: { name: 'action-ingest', stdin: 'messages_json' },
    handler: async (ctx, p) => {
      const db = await ensureActionBrainSchema(ctx.engine);
      const engine = new ActionEngine(db);
      const messages = parseMessagesParam(p.messages ?? p.messages_json);
      const providedCommitments = parseCommitmentsParam(p.commitments);
      const actor = asOptionalNonEmptyString(p.actor) ?? 'extractor';
      const extractionModel =
        providedCommitments.length > 0
          ? 'direct_commitments'
          : asOptionalNonEmptyString(p.model) ?? HAIKU_MODEL;
      const runId = randomUUID();

      if (messages.length === 0 && providedCommitments.length === 0) {
        throw new Error('action_ingest requires messages (or commitments for deterministic ingest).');
      }

      const runSummary = createEmptyExtractionRunSummary();
      const minConfidence = clampConfidenceThreshold(asOptionalNumber(p.min_confidence));
      let extracted: StructuredCommitment[] = providedCommitments;
      if (providedCommitments.length === 0) {
        const extraction = await extractCommitmentsWithSummary(messages, {
          model: asOptionalNonEmptyString(p.model) ?? undefined,
          timeoutMs: asOptionalNumber(p.timeout_ms) ?? undefined,
          runSummary,
        });
        extracted = extraction.commitments;
      }
      extracted = filterLowConfidenceCommitments(extracted, minConfidence, runSummary);

      const dropped: ActionDrop[] = [];
      if (ctx.dryRun) {
        for (let i = 0; i < extracted.length; i += 1) {
          const commitment = extracted[i];
          if (!isLowConfidenceCommitment(commitment)) continue;

          const message = resolveSourceMessage(messages, commitment);
          const sourceId = buildCommitmentSourceId(
            resolveSourceMessageId(messages, commitment, message),
            commitment
          );

          dropped.push({
            id: -1,
            run_id: runId,
            source_id: sourceId,
            source_excerpt: buildDropSourceExcerpt(message),
            drop_reason: 'low_confidence',
            confidence: commitment.confidence,
            extractor_version: ACTION_EXTRACTOR_VERSION,
            model: extractionModel,
            created_at: new Date(),
          });
        }

        return {
          dry_run: true,
          extracted_count: extracted.length,
          dropped_count: dropped.length,
          extracted,
          run_summary: runSummary,
          dropped,
        };
      }

      const items = [];
      for (let i = 0; i < extracted.length; i += 1) {
        const commitment = extracted[i];
        const message = resolveSourceMessage(messages, commitment);
        const sourceMessageId = buildCommitmentSourceId(
          resolveSourceMessageId(messages, commitment, message),
          commitment
        );

        if (isLowConfidenceCommitment(commitment)) {
          const droppedRow = await insertActionDrop(db, {
            runId,
            sourceId: sourceMessageId,
            sourceExcerpt: buildDropSourceExcerpt(message),
            dropReason: 'low_confidence',
            confidence: commitment.confidence,
            extractorVersion: ACTION_EXTRACTOR_VERSION,
            model: extractionModel,
          });
          dropped.push(droppedRow);
          continue;
        }

        const dueAt = parseOptionalDate(commitment.by_when, 'by_when');

        const item = await engine.createItem(
          {
            title: toActionTitle(commitment.owes_what),
            type: commitment.type,
            source_message_id: sourceMessageId,
            owner: commitment.who ?? '',
            waiting_on: null,
            due_at: dueAt,
            confidence: commitment.confidence,
            source_thread: message?.ChatName ?? '',
            source_contact: message?.SenderName ?? '',
            linked_entity_slugs: [],
          },
          {
            actor,
            metadata: {
              ingestion_mode: providedCommitments.length > 0 ? 'direct_commitments' : 'extracted',
            },
          }
        );

        items.push(item);
      }

      return {
        run_id: runId,
        extracted_count: extracted.length,
        created_count: items.length,
        run_summary: runSummary,
        dropped_count: dropped.length,
        dropped,
        items,
      };
    },
  },
];

async function ensureActionBrainSchema(engine: BrainEngine): Promise<QueryableDb> {
  const key = engine as unknown as object;
  const db = await resolveActionDb(engine);

  if (initializedEngines.has(key)) {
    return db;
  }

  if (typeof db.exec !== 'function') {
    throw new Error('Action Brain schema initialization requires an exec-capable database adapter.');
  }

  await initActionSchema({ exec: db.exec.bind(db) });
  initializedEngines.add(key);
  return db;
}

async function resolveActionDb(engine: BrainEngine): Promise<QueryableDb> {
  const candidate = engine as unknown as Record<string, unknown>;
  const pgliteDb = candidate.db as QueryableDb | undefined;
  if (pgliteDb && typeof pgliteDb.query === 'function' && typeof pgliteDb.exec === 'function') {
    return pgliteDb;
  }

  const cacheKey = engine as unknown as object;
  const cachedPostgresDb = postgresDbCache.get(cacheKey);
  if (cachedPostgresDb) {
    return cachedPostgresDb;
  }

  const sql = candidate.sql as PostgresUnsafeConnection | undefined;
  if (sql && typeof sql.unsafe === 'function') {
    const wrap = (conn: PostgresUnsafeConnection): QueryableDb => ({
      query: async <T = Record<string, unknown>>(statement: string, params: unknown[] = []) => {
        const rows = params.length === 0 ? await conn.unsafe(statement) : await conn.unsafe(statement, params);
        return { rows: rows as T[] };
      },
      exec: async (statement: string) => {
        await conn.unsafe(statement);
      },
      transaction:
        typeof conn.begin === 'function'
          ? async <T>(fn: (txDb: QueryableDb) => Promise<T>) => {
              return conn.begin(async (tx) => fn(wrap(tx)));
            }
          : undefined,
    });

    const wrapped = wrap(sql);
    postgresDbCache.set(cacheKey, wrapped);
    return wrapped;
  }

  throw new Error('Unsupported engine for Action Brain operations. Expected PGLiteEngine or PostgresEngine.');
}

function parseMessagesParam(value: unknown): WhatsAppMessage[] {
  const raw = parseJsonArrayInput(value);
  if (raw.length === 0) {
    return [];
  }

  const normalized: WhatsAppMessage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const msgId = asOptionalNonEmptyString(entry.MsgID);
    const text = asOptionalNonEmptyString(entry.Text);
    if (!msgId || !text) continue;

    normalized.push({
      ChatName: asOptionalNonEmptyString(entry.ChatName) ?? '',
      SenderName: asOptionalNonEmptyString(entry.SenderName) ?? '',
      Timestamp: asOptionalNonEmptyString(entry.Timestamp) ?? '',
      Text: text,
      MsgID: msgId,
    });
  }

  return normalized;
}

function parseCommitmentsParam(value: unknown): StructuredCommitment[] {
  const raw = parseJsonArrayInput(value);
  if (raw.length === 0) {
    return [];
  }

  const normalized: StructuredCommitment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;

    const owesWhat = asOptionalNonEmptyString(entry.owes_what);
    if (!owesWhat) continue;

    const type = asOptionalNonEmptyString(entry.type);
    if (!isActionType(type)) continue;

    normalized.push({
      who: asOptionalNonEmptyString(entry.who) ?? null,
      owes_what: owesWhat,
      to_whom: asOptionalNonEmptyString(entry.to_whom) ?? null,
      by_when: asOptionalNonEmptyString(entry.by_when) ?? null,
      confidence: clampConfidence(entry.confidence),
      type,
      source_message_id: asOptionalNonEmptyString(entry.source_message_id),
    });
  }

  return normalized;
}

const STATUSLESS_ACTION_TYPES = new Set<StructuredCommitment['type']>([
  'commitment',
  'follow_up',
  'decision',
  'question',
  'delegation',
]);

function isActionType(value: string | null): value is StructuredCommitment['type'] {
  return typeof value === 'string' && STATUSLESS_ACTION_TYPES.has(value as StructuredCommitment['type']);
}

function parseJsonArrayInput(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function resolveSourceMessage(messages: WhatsAppMessage[], commitment: StructuredCommitment): WhatsAppMessage | null {
  if (messages.length === 0) {
    return null;
  }

  const explicitSourceMessageId = asOptionalNonEmptyString(commitment.source_message_id);
  if (explicitSourceMessageId) {
    const matched = messages.find((message) => message.MsgID === explicitSourceMessageId);
    if (matched) {
      return matched;
    }
  }

  return messages.length === 1 ? messages[0] : null;
}

function resolveSourceMessageId(
  messages: WhatsAppMessage[],
  commitment: StructuredCommitment,
  message: WhatsAppMessage | null
): string | null {
  if (message) {
    return message.MsgID;
  }

  // Only trust direct source ids when no message batch is available to validate against.
  if (messages.length === 0) {
    return asOptionalNonEmptyString(commitment.source_message_id);
  }

  return null;
}

function buildCommitmentSourceId(sourceMessageId: string | null, commitment: StructuredCommitment): string {
  const baseMsgId = asOptionalNonEmptyString(sourceMessageId) ?? 'batch';
  const seed = [
    baseMsgId,
    normalizeCommitmentField(commitment.who),
    normalizeCommitmentField(commitment.owes_what),
    normalizeCommitmentField(commitment.to_whom),
    normalizeCommitmentField(commitment.by_when),
    commitment.type,
  ].join('|');
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  return `${baseMsgId}:ab:${digest}`;
}

function normalizeCommitmentField(value: string | null | undefined): string {
  if (!value) return '';
  return value.trim().toLowerCase();
}

function toActionTitle(owesWhat: string): string {
  const text = owesWhat.trim();
  if (text.length <= 160) return text;
  return `${text.slice(0, 157)}...`;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asRequiredInteger(value: unknown, param: string): number {
  const parsed = asOptionalNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${param}: expected integer`);
  }
  return parsed;
}

function asOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function parseOptionalDate(value: unknown, field: string): Date | null {
  const text = asOptionalNonEmptyString(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field}: ${text}`);
  }
  return parsed;
}

function clampConfidence(value: unknown): number {
  const parsed = asOptionalNumber(value);
  if (parsed === undefined) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, parsed));
}

function clampConfidenceThreshold(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function filterLowConfidenceCommitments(
  commitments: StructuredCommitment[],
  minConfidence: number,
  runSummary: { extraction_low_confidence_drops: number }
): StructuredCommitment[] {
  if (minConfidence <= 0) {
    return commitments;
  }

  const filtered: StructuredCommitment[] = [];
  for (const commitment of commitments) {
    if (commitment.confidence < minConfidence) {
      runSummary.extraction_low_confidence_drops += 1;
      continue;
    }
    filtered.push(commitment);
  }
  return filtered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseActionListFilter(value: unknown): ActionListFilter | undefined {
  const parsed = asOptionalNonEmptyString(value);
  if (!parsed) return undefined;
  return parsed === 'low_confidence_dropped' ? parsed : undefined;
}

function isLowConfidenceCommitment(commitment: StructuredCommitment): boolean {
  return commitment.confidence < LOW_CONFIDENCE_THRESHOLD;
}

function buildDropSourceExcerpt(message: WhatsAppMessage | null): string {
  const sourceText = asOptionalNonEmptyString(message?.Text);
  if (!sourceText) {
    return '';
  }
  return redactAndBoundExcerpt(sourceText);
}

function redactAndBoundExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const redactedEmails = normalized.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]');
  const redactedPhones = redactedEmails.replace(/\+?\d[\d\s\-()]{6,}\d/g, '[redacted-number]');
  if (redactedPhones.length <= SOURCE_EXCERPT_MAX_CHARS) {
    return redactedPhones;
  }
  return redactedPhones.slice(0, SOURCE_EXCERPT_MAX_CHARS);
}

async function insertActionDrop(
  db: QueryableDb,
  input: {
    runId: string;
    sourceId: string;
    sourceExcerpt: string;
    dropReason: ActionDropReason;
    confidence: number;
    extractorVersion: string;
    model: string;
  }
): Promise<ActionDrop> {
  const result = await db.query<ActionDropRow>(
    `INSERT INTO action_drops (
       run_id,
       source_id,
       source_excerpt,
       drop_reason,
       confidence,
       extractor_version,
       model
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.runId,
      input.sourceId,
      input.sourceExcerpt,
      input.dropReason,
      input.confidence,
      input.extractorVersion,
      input.model,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to persist action drop record.');
  }
  return mapActionDrop(row);
}

async function listActionDrops(db: QueryableDb, filters: ListActionDropFilters = {}): Promise<ActionDrop[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.dropReason) {
    params.push(filters.dropReason);
    where.push(`drop_reason = $${params.length}`);
  }

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const result = await db.query<ActionDropRow>(
    `SELECT *
     FROM action_drops
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limitParam}
     OFFSET ${offsetParam}`,
    params
  );

  return result.rows.map(mapActionDrop);
}

async function listActionDrafts(
  db: QueryableDb,
  filters: {
    status?: ActionDraftStatus;
    actionItemId?: number;
    limit?: number;
    offset?: number;
  }
): Promise<Array<ActionDraft & { action: { id: number; title: string; status: string; priority_score: number } }>> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    params.push(filters.status);
    where.push(`d.status = $${params.length}`);
  }
  if (typeof filters.actionItemId === 'number') {
    params.push(filters.actionItemId);
    where.push(`d.action_item_id = $${params.length}`);
  }

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const result = await db.query<ActionDraftListRow>(
    `SELECT
       d.*,
       ai.priority_score AS action_priority_score,
       ai.status AS action_status,
       ai.title AS action_title
     FROM action_drafts d
     JOIN action_items ai ON ai.id = d.action_item_id
     ${whereClause}
     ORDER BY ai.priority_score DESC, d.generated_at DESC, d.id DESC
     LIMIT ${limitParam}
     OFFSET ${offsetParam}`,
    params
  );

  return result.rows.map((row) => ({
    ...mapActionDraftRecord(row),
    action: {
      id: Number(row.action_item_id),
      title: row.action_title,
      status: row.action_status,
      priority_score: Number(row.action_priority_score),
    },
  }));
}

async function getActionDraftStateForUpdate(db: QueryableDb, draftId: number): Promise<ActionDraftStateRow | null> {
  const result = await db.query<ActionDraftStateRow>(
    `SELECT
       d.id,
       d.action_item_id,
       d.status,
       d.channel,
       d.recipient,
       d.draft_text,
       d.approved_at,
       d.sent_at
     FROM action_drafts d
     WHERE d.id = $1
     FOR UPDATE`,
    [draftId]
  );

  return result.rows[0] ?? null;
}

async function markDraftApproved(db: QueryableDb, draftId: number): Promise<ActionDraftStateRow | null> {
  const result = await db.query<ActionDraftStateRow>(
    `UPDATE action_drafts
     SET status = 'approved',
         approved_at = now(),
         send_error = NULL
     WHERE id = $1
       AND status = 'pending'
     RETURNING id, action_item_id, status, channel, recipient, draft_text, approved_at, sent_at`,
    [draftId]
  );
  return result.rows[0] ?? null;
}

async function reopenFailedDraftForRetry(db: QueryableDb, draftId: number): Promise<ActionDraftStateRow | null> {
  const result = await db.query<ActionDraftStateRow>(
    `UPDATE action_drafts
     SET status = 'approved',
         send_error = NULL,
         approved_at = COALESCE(approved_at, now())
     WHERE id = $1
       AND status = 'send_failed'
     RETURNING id, action_item_id, status, channel, recipient, draft_text, approved_at, sent_at`,
    [draftId]
  );
  return result.rows[0] ?? null;
}

async function updateDraftRejected(db: QueryableDb, draftId: number): Promise<ActionDraftRow | null> {
  const result = await db.query<ActionDraftRow>(
    `UPDATE action_drafts
     SET status = 'rejected'
     WHERE id = $1
       AND status = 'pending'
     RETURNING *`,
    [draftId]
  );
  return result.rows[0] ?? null;
}

async function updateDraftText(db: QueryableDb, draftId: number, text: string): Promise<ActionDraftRow | null> {
  const result = await db.query<ActionDraftRow>(
    `UPDATE action_drafts
     SET draft_text = $2,
         status = 'pending',
         send_error = NULL
     WHERE id = $1
       AND status = 'pending'
     RETURNING *`,
    [draftId, text]
  );
  return result.rows[0] ?? null;
}

async function lockActionItemForDraft(db: QueryableDb, itemId: number): Promise<ActionItemDraftSeedRow | null> {
  const result = await db.query<ActionItemDraftSeedRow>(
    `SELECT id, title, source_contact
     FROM action_items
     WHERE id = $1
     FOR UPDATE`,
    [itemId]
  );
  return result.rows[0] ?? null;
}

async function supersedePendingDrafts(db: QueryableDb, itemId: number): Promise<number[]> {
  const result = await db.query<{ id: number | string }>(
    `UPDATE action_drafts
     SET status = 'superseded'
     WHERE action_item_id = $1
       AND status = 'pending'
     RETURNING id`,
    [itemId]
  );
  return result.rows.map((row) => Number(row.id));
}

async function getLatestDraftForItem(db: QueryableDb, itemId: number): Promise<ActionDraftRow | null> {
  const result = await db.query<ActionDraftRow>(
    `SELECT *
     FROM action_drafts
     WHERE action_item_id = $1
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    [itemId]
  );
  return result.rows[0] ?? null;
}

function resolveRecipientForRegeneratedDraft(item: ActionItemDraftSeedRow): string | null {
  return asOptionalNonEmptyString(item.source_contact);
}

function buildRegeneratedDraftText(item: ActionItemDraftSeedRow, latestDraft: ActionDraftRow | null, hint: string | null): string {
  if (latestDraft && asOptionalNonEmptyString(latestDraft.draft_text)) {
    return latestDraft.draft_text;
  }
  const hintSuffix = hint ? ` (${hint})` : '';
  return `Hi - following up on: ${item.title}${hintSuffix}`;
}

function buildRegeneratedContextSnapshot(
  item: ActionItemDraftSeedRow,
  latestDraft: ActionDraftRow | null,
  hint: string | null
): Record<string, unknown> {
  const latestSnapshot = latestDraft ? parseJsonObject(latestDraft.context_snapshot, 'context_snapshot') : {};
  return {
    ...latestSnapshot,
    item_id: item.id,
    item_title: item.title,
    source_contact: item.source_contact,
    regeneration_hint: hint ?? null,
  };
}

function hashContextSnapshot(snapshot: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

async function insertRegeneratedDraft(
  db: QueryableDb,
  input: {
    actionItemId: number;
    recipient: string;
    draftText: string;
    model: string;
    contextHash: string;
    contextSnapshot: Record<string, unknown>;
  }
): Promise<ActionDraftRow> {
  const result = await db.query<ActionDraftRow>(
    `WITH next_version AS (
       SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM action_drafts
       WHERE action_item_id = $1
     )
     INSERT INTO action_drafts (
       action_item_id,
       version,
       status,
       channel,
       recipient,
       draft_text,
       model,
       context_hash,
       context_snapshot
     )
     SELECT
       $1,
       next_version.version,
       'pending',
       'whatsapp',
       $2,
       $3,
       $4,
       $5,
       $6::jsonb
     FROM next_version
     RETURNING *`,
    [
      input.actionItemId,
      input.recipient,
      input.draftText,
      input.model,
      input.contextHash,
      JSON.stringify(input.contextSnapshot),
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to regenerate draft for action item ${input.actionItemId}`);
  }
  return row;
}

async function markDraftSent(db: QueryableDb, draftId: number): Promise<ActionDraftRow | null> {
  const result = await db.query<ActionDraftRow>(
    `UPDATE action_drafts
     SET status = 'sent',
         sent_at = now(),
         send_error = NULL
     WHERE id = $1
       AND status = 'approved'
     RETURNING *`,
    [draftId]
  );
  return result.rows[0] ?? null;
}

async function hasDraftDeliveryConfirmation(db: QueryableDb, itemId: number, draftId: number): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM action_history
     WHERE item_id = $1
       AND event_type = 'draft_sent'
       AND metadata @> jsonb_build_object('draft_id', $2::int, 'delivery_confirmed', true)
     LIMIT 1`,
    [itemId, draftId]
  );
  return result.rows.length > 0;
}

async function recordDraftDeliveryConfirmation(
  db: QueryableDb,
  itemId: number,
  draftId: number,
  actor: string,
  resumedFromStatus: 'approved' | 'send_failed' | null
): Promise<void> {
  await withDbTransaction(db, async (txDb) => {
    await insertActionHistory(txDb, itemId, 'draft_sent', actor, {
      draft_id: draftId,
      resumed_from_status: resumedFromStatus,
      delivery_confirmed: true,
    });
  });
}

async function persistDraftSentState(db: QueryableDb, draftId: number): Promise<ActionDraftRow> {
  return withDbTransaction(db, async (txDb) => {
    const updated = await markDraftSent(txDb, draftId);
    if (!updated) {
      throw new Error(`Action draft not found: ${draftId}`);
    }

    await transitionParentActionItemAfterSend(txDb, updated.action_item_id);
    return updated;
  });
}

async function updateDraftSendFailed(db: QueryableDb, draftId: number, sendError: string): Promise<ActionDraftRow | null> {
  const result = await db.query<ActionDraftRow>(
    `UPDATE action_drafts
     SET status = 'send_failed',
         send_error = $2
     WHERE id = $1
       AND status = 'approved'
     RETURNING *`,
    [draftId, sendError]
  );
  return result.rows[0] ?? null;
}

async function transitionParentActionItemAfterSend(db: QueryableDb, itemId: number): Promise<void> {
  await db.query(
    `UPDATE action_items
     SET status = 'in_progress',
         updated_at = now()
     WHERE id = $1
       AND status = 'waiting_on'`,
    [itemId]
  );
}

async function insertActionHistory(
  db: QueryableDb,
  itemId: number,
  eventType:
    | 'draft_created'
    | 'draft_approved'
    | 'draft_edited'
    | 'draft_rejected'
    | 'draft_sent'
    | 'draft_send_failed',
  actor: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.query(
    `INSERT INTO action_history (item_id, event_type, actor, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [itemId, eventType, actor, JSON.stringify(metadata)]
  );
}

function mapActionDraftState(row: ActionDraftStateRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    action_item_id: Number(row.action_item_id),
    status: row.status,
    channel: row.channel,
    recipient: row.recipient,
    draft_text: row.draft_text,
    approved_at: toOptionalDate(row.approved_at),
    sent_at: toOptionalDate(row.sent_at),
  };
}

function mapActionDraftRecord(row: ActionDraftRow): ActionDraft {
  return {
    id: Number(row.id),
    action_item_id: Number(row.action_item_id),
    version: Number(row.version),
    status: row.status,
    channel: row.channel as ActionDraft['channel'],
    recipient: row.recipient,
    draft_text: row.draft_text,
    model: row.model,
    context_hash: row.context_hash,
    context_snapshot: parseJsonObject(row.context_snapshot, 'context_snapshot'),
    generated_at: toDate(row.generated_at),
    approved_at: toOptionalDate(row.approved_at),
    sent_at: toOptionalDate(row.sent_at),
    send_error: row.send_error,
  };
}

async function sendDraftViaWacli(recipient: string, text: string, timeoutMs: number): Promise<void> {
  const to = asOptionalNonEmptyString(recipient);
  if (!to) {
    throw new Error('Draft recipient is empty.');
  }

  await sendTextExecutor('wacli', ['send', 'text', '--to', to, '--message', text], { timeoutMs });
}

async function defaultSendTextExecutor(
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<SendCommandResult> {
  const result = await execFileAsync(command, args, {
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseActionDraftStatus(value: unknown): ActionDraftStatusValue | undefined {
  const parsed = asOptionalNonEmptyString(value);
  if (!parsed) {
    return undefined;
  }
  if ((ACTION_DRAFT_STATUS_VALUES as readonly string[]).includes(parsed)) {
    return parsed as ActionDraftStatusValue;
  }
  throw new Error(`Invalid status: ${parsed}`);
}

function asOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = asOptionalNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${field}: expected integer`);
  }
  return parsed;
}

function parseJsonObject(value: Record<string, unknown> | string, field: string): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid ${field} value`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid ${field} value`);
  }
}

function toOptionalDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return toDate(value);
}

async function withDbTransaction<T>(db: QueryableDb, fn: (txDb: QueryableDb) => Promise<T>): Promise<T> {
  if (typeof db.transaction === 'function') {
    return db.transaction(fn);
  }

  await db.query('BEGIN');
  try {
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      // Best-effort rollback; preserve original error.
    }
    throw error;
  }
}

function mapActionDrop(row: ActionDropRow): ActionDrop {
  return {
    id: Number(row.id),
    run_id: row.run_id,
    source_id: row.source_id,
    source_excerpt: row.source_excerpt,
    drop_reason: row.drop_reason,
    confidence: Number(row.confidence),
    extractor_version: row.extractor_version,
    model: row.model,
    created_at: toDate(row.created_at),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function buildSourceContactLinks(engine: BrainEngine, items: ActionItem[]): Promise<Map<number, string>> {
  const linksByItemId = new Map<number, string>();
  const contactsNeedingLookup: string[] = [];
  const seenContacts = new Set<string>();

  for (const item of items) {
    const sourceContact = asOptionalNonEmptyString(item.source_contact);
    if (!sourceContact) continue;

    const linkedSlug = pickLinkedEntitySlug(item.linked_entity_slugs);
    if (linkedSlug) {
      linksByItemId.set(item.id, formatSourceContactLink(sourceContact, linkedSlug));
      continue;
    }

    if (!seenContacts.has(sourceContact)) {
      seenContacts.add(sourceContact);
      contactsNeedingLookup.push(sourceContact);
    }
  }

  const resolvedLookupPairs = await mapWithConcurrency(
    contactsNeedingLookup.slice(0, ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CAP),
    ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CONCURRENCY,
    async (sourceContact) => [sourceContact, await resolveEntitySlugForSourceContact(engine, sourceContact)] as const
  );
  const slugBySourceContact = new Map<string, string | null>(resolvedLookupPairs);

  for (const item of items) {
    if (linksByItemId.has(item.id)) {
      continue;
    }

    const sourceContact = asOptionalNonEmptyString(item.source_contact);
    if (!sourceContact) continue;

    const resolvedSlug = slugBySourceContact.get(sourceContact) ?? null;
    if (!resolvedSlug) continue;
    linksByItemId.set(item.id, formatSourceContactLink(sourceContact, resolvedSlug));
  }

  return linksByItemId;
}

async function resolveEntitySlugForSourceContact(engine: BrainEngine, sourceContact: string): Promise<string | null> {
  const slugBase = toEntitySlugBase(sourceContact);
  if (!slugBase) {
    return null;
  }

  const candidateSlugs = [`people/${slugBase}`, `companies/${slugBase}`];
  const resolverMatches = new Set<string>();

  for (const candidateSlug of candidateSlugs) {
    try {
      const resolved = await engine.resolveSlugs(candidateSlug);
      if (resolved.includes(candidateSlug)) {
        resolverMatches.add(candidateSlug);
      }
    } catch {
      // Best-effort resolution; unresolved contacts should never fail brief generation.
    }
  }

  if (resolverMatches.size === 0) {
    return null;
  }

  try {
    const keywordHits = await engine.searchKeyword(sourceContact, {
      limit: ENTITY_LINK_SEARCH_LIMIT,
      detail: 'low',
    });
    const hitSlugs = new Set(keywordHits.map((hit) => hit.slug).filter((slug) => isEntitySlug(slug)));
    const matchedCandidates = candidateSlugs.filter(
      (candidateSlug) => resolverMatches.has(candidateSlug) && hitSlugs.has(candidateSlug)
    );
    if (matchedCandidates.length === 1) {
      return matchedCandidates[0];
    }
  } catch {
    // Best-effort lookup; unresolved contacts should never fail brief generation.
  }

  return null;
}

function pickLinkedEntitySlug(slugs: string[]): string | null {
  const uniqueEntitySlugs = new Set<string>();
  for (const slug of slugs) {
    if (isEntitySlug(slug)) {
      uniqueEntitySlugs.add(slug);
    }
  }
  return uniqueEntitySlugs.size === 1 ? [...uniqueEntitySlugs][0] : null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: effectiveConcurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

function isEntitySlug(slug: string): boolean {
  return slug.startsWith('people/') || slug.startsWith('companies/');
}

function toEntitySlugBase(sourceContact: string): string {
  return sourceContact
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatSourceContactLink(sourceContact: string, slug: string): string {
  return `[${escapeMarkdownLinkText(sourceContact)}](${slug})`;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

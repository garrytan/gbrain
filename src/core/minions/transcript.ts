/**
 * Render a subagent conversation to markdown.
 *
 * Two inputs:
 *  - subagent_messages rows (persisted Anthropic message-block arrays)
 *  - subagent_tool_executions rows (two-phase tool ledger — used to show
 *    tool outputs alongside the model's tool_use calls)
 *
 * The output is suitable for:
 *  - an attachment on the completed subagent job row
 *  - inline display in `gbrain agent logs <job>` after the heartbeat stream
 *  - committing as a brain page under wiki/agents/<subagentId>/transcript-*
 *
 * Does NOT redact anything — the caller writes to a location they control.
 * For PII-sensitive deployments, pass through a sanitizer before persisting.
 */

import type { BrainEngine } from '../engine.ts';
import type { ContentBlock } from './types.ts';

export interface SubagentMessageRow {
  id: number;
  job_id: number;
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: ContentBlock[];
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
  ended_at: Date;
}

export interface SubagentToolExecRow {
  id: number;
  job_id: number;
  message_idx: number;
  /** D11 stable ordinal (per-turn tool-call position). NULL on legacy rows. */
  ordinal: number | null;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

/** Fetch both row sets for a job in one shot. */
export async function loadTranscriptRows(
  engine: BrainEngine,
  jobId: number,
): Promise<{ messages: SubagentMessageRow[]; tools: SubagentToolExecRow[] }> {
  const msgRows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, job_id, message_idx, role, content_blocks, tokens_in, tokens_out,
            tokens_cache_read, tokens_cache_create, model, ended_at
       FROM subagent_messages
      WHERE job_id = $1
      ORDER BY message_idx ASC`,
    [jobId],
  );
  const toolRows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, job_id, message_idx, ordinal, tool_use_id, tool_name, input, status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1
      ORDER BY id ASC`,
    [jobId],
  );
  return {
    messages: msgRows.map(normalizeMessage),
    tools: toolRows.map(normalizeTool),
  };
}

function normalizeMessage(row: Record<string, unknown>): SubagentMessageRow {
  const blocks = row.content_blocks;
  const parsedBlocks: ContentBlock[] = typeof blocks === 'string'
    ? (JSON.parse(blocks) as ContentBlock[])
    : (blocks as ContentBlock[]) ?? [];
  return {
    id: row.id as number,
    job_id: row.job_id as number,
    message_idx: row.message_idx as number,
    role: row.role as 'user' | 'assistant',
    content_blocks: parsedBlocks,
    tokens_in: (row.tokens_in as number) ?? null,
    tokens_out: (row.tokens_out as number) ?? null,
    tokens_cache_read: (row.tokens_cache_read as number) ?? null,
    tokens_cache_create: (row.tokens_cache_create as number) ?? null,
    model: (row.model as string) ?? null,
    ended_at: new Date(row.ended_at as string),
  };
}

function normalizeTool(row: Record<string, unknown>): SubagentToolExecRow {
  const input = typeof row.input === 'string' ? JSON.parse(row.input) : row.input;
  const output = row.output == null
    ? null
    : (typeof row.output === 'string' ? JSON.parse(row.output) : row.output);
  return {
    id: row.id as number,
    job_id: row.job_id as number,
    message_idx: row.message_idx as number,
    ordinal: (row.ordinal as number | null) ?? null,
    tool_use_id: row.tool_use_id as string,
    tool_name: row.tool_name as string,
    input,
    status: row.status as 'pending' | 'complete' | 'failed',
    output,
    error: (row.error as string) ?? null,
  };
}

export interface RenderTranscriptOpts {
  /** Trim long tool outputs in the markdown. Default: 4 KiB per output. */
  maxOutputBytes?: number;
}

/**
 * Render messages + tool executions to markdown. Message order is
 * authoritative; tool rows are spliced under their owning assistant message
 * by (message_idx, tool_use_id) — raw provider ids may repeat across turns.
 */
export function renderTranscript(
  messages: SubagentMessageRow[],
  tools: SubagentToolExecRow[],
  opts: RenderTranscriptOpts = {},
): string {
  const maxOut = opts.maxOutputBytes ?? 4096;
  // Keyed by (message_idx, tool_use_id) — raw provider tool_use_ids may
  // repeat across turns (#4155: replay-style providers like claude-cli reuse
  // the same short id on every turn), so tool_use_id alone would collapse
  // distinct executions onto one row and mis-attribute status/output.
  const toolByMsgAndId = new Map<string, SubagentToolExecRow>(
    tools.map(t => [`${t.message_idx}:${t.tool_use_id}`, t]),
  );
  // Ordinal-first resolution for stamped rows: within one turn a raw id can
  // even repeat (the composite id map is last-write-wins for that shape);
  // the persisted D11 ordinal equals the tool_use block position, which is
  // exact.
  const toolByMsgAndOrdinal = new Map<string, SubagentToolExecRow>();
  for (const t of tools) {
    if (t.ordinal != null) toolByMsgAndOrdinal.set(`${t.message_idx}:${t.ordinal}`, t);
  }

  const out: string[] = [];
  out.push('# Subagent transcript', '');
  if (messages.length === 0) {
    out.push('_(no messages)_');
    return out.join('\n');
  }

  const first = messages[0]!;
  out.push(`- job_id: ${first.job_id}`);
  out.push(`- messages: ${messages.length}`);
  if (first.model) out.push(`- model: ${first.model}`);
  out.push('');

  // tool_result blocks live in the user message FOLLOWING the owning
  // assistant message; track the nearest preceding assistant idx so their
  // ownership check uses that turn's composite key (a job-wide id set would
  // wrongly suppress a result whose own turn has no execution row when a
  // DIFFERENT turn reused the id).
  let prevAssistantIdx: number | null = null;

  for (const msg of messages) {
    out.push(`## Message ${msg.message_idx} — ${msg.role}`);
    if (msg.tokens_in != null || msg.tokens_out != null) {
      const parts: string[] = [];
      if (msg.tokens_in) parts.push(`in=${msg.tokens_in}`);
      if (msg.tokens_out) parts.push(`out=${msg.tokens_out}`);
      if (msg.tokens_cache_read) parts.push(`cache_read=${msg.tokens_cache_read}`);
      if (msg.tokens_cache_create) parts.push(`cache_create=${msg.tokens_cache_create}`);
      if (parts.length > 0) out.push(`> tokens: ${parts.join(' ')}`);
    }
    out.push('');

    // Ids repeated WITHIN this message make the (message_idx, raw id) key
    // ambiguous — resolution for those falls to the stamped ordinal only.
    const idCounts = new Map<string, number>();
    for (const b of msg.content_blocks) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        idCounts.set(b.id, (idCounts.get(b.id) ?? 0) + 1);
      }
    }
    let toolUseOrdinal = 0; // tool_use block position within this message
    for (const block of msg.content_blocks) {
      const blockOrdinal = block.type === 'tool_use' ? toolUseOrdinal++ : -1;
      const idIsUniqueInMsg = !(block.type === 'tool_use' && typeof block.id === 'string'
        && (idCounts.get(block.id) ?? 0) > 1);
      renderBlock(block, msg.message_idx, blockOrdinal, idIsUniqueInMsg, prevAssistantIdx, toolByMsgAndId, toolByMsgAndOrdinal, maxOut, out);
    }
    out.push('');
    if (msg.role === 'assistant') prevAssistantIdx = msg.message_idx;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderBlock(
  block: ContentBlock,
  messageIdx: number,
  /** tool_use block position within the message (-1 for non-tool_use blocks). */
  blockOrdinal: number,
  /** false when this tool_use block's id repeats within the message. */
  idIsUniqueInMsg: boolean,
  prevAssistantIdx: number | null,
  toolByMsgAndId: Map<string, SubagentToolExecRow>,
  toolByMsgAndOrdinal: Map<string, SubagentToolExecRow>,
  maxOutputBytes: number,
  out: string[],
): void {
  if (block.type === 'text' && typeof block.text === 'string') {
    out.push(block.text);
    out.push('');
    return;
  }

  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : '<unknown>';
    const inputStr = safeJson(block.input, 2);
    out.push(`**tool_use** \`${name}\` (id=\`${block.id ?? '?'}\`)`);
    out.push('```json', inputStr, '```');
    // Execution rows are written with the OWNING assistant message's idx.
    // Resolve by the stamped (message_idx, ordinal) first — validated by the
    // raw id — then by (message_idx, raw id) for legacy rows.
    const stamped = toolByMsgAndOrdinal.get(`${messageIdx}:${blockOrdinal}`);
    const toolRow = (stamped && typeof block.id === 'string' && stamped.tool_use_id === block.id)
      ? stamped
      : (idIsUniqueInMsg && block.id && typeof block.id === 'string'
        ? toolByMsgAndId.get(`${messageIdx}:${block.id}`)
        : undefined);
    if (toolRow) {
      out.push(`→ status: **${toolRow.status}**`);
      if (toolRow.status === 'complete') {
        out.push('```json', truncate(safeJson(toolRow.output, 2), maxOutputBytes), '```');
      } else if (toolRow.status === 'failed') {
        out.push(`> error: ${toolRow.error ?? '(no error text)'}`);
      } else if (toolRow.status === 'pending') {
        out.push('> pending (no resolution recorded yet)');
      }
    }
    out.push('');
    return;
  }

  if (block.type === 'tool_result') {
    // Most tool_result blocks live inside user messages echoing back the
    // assistant's tool_use. We skip them here because the owning tool_use
    // block already rendered the execution row. Ownership is checked against
    // the nearest PRECEDING assistant turn's key — raw ids may repeat across
    // turns, so a job-wide id match could suppress a result whose own turn
    // has no execution row. If no owning row exists (rare), dump it raw.
    const owned = prevAssistantIdx !== null
      && typeof block.tool_use_id === 'string'
      && toolByMsgAndId.has(`${prevAssistantIdx}:${block.tool_use_id}`);
    if (!owned) {
      out.push('**tool_result** (no matching tool_use in this transcript)');
      out.push('```json', truncate(safeJson(block.content, 2), maxOutputBytes), '```');
      out.push('');
    }
    return;
  }

  // Unknown block type — dump as a fenced JSON block for diagnostics.
  out.push(`**${block.type}**`);
  out.push('```json', truncate(safeJson(block, 2), maxOutputBytes), '```');
  out.push('');
}

function safeJson(value: unknown, indent = 0): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  // Slice bytewise via Buffer so we don't split a multibyte char awkwardly.
  const buf = Buffer.from(s, 'utf8').slice(0, maxBytes);
  return buf.toString('utf8') + `\n... [truncated at ${maxBytes} bytes]`;
}

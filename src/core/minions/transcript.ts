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
    `SELECT id, job_id, message_idx, tool_use_id, tool_name, input, status, output, error
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
 * by tool_use_id.
 */
export function renderTranscript(
  messages: SubagentMessageRow[],
  tools: SubagentToolExecRow[],
  opts: RenderTranscriptOpts = {},
): string {
  const maxOut = opts.maxOutputBytes ?? 4096;
  const toolById = new Map<string, SubagentToolExecRow>(
    tools.map(t => [t.tool_use_id, t]),
  );

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

    for (const block of msg.content_blocks) {
      renderBlock(block, toolById, maxOut, out);
    }
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderBlock(
  block: ContentBlock,
  toolById: Map<string, SubagentToolExecRow>,
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
    const toolRow = block.id && typeof block.id === 'string' ? toolById.get(block.id) : undefined;
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
    // block already rendered the execution row. If the user message carries
    // a raw tool_result with no matching tool_use (rare), dump it raw.
    if (!block.tool_use_id || !toolById.has(block.tool_use_id as string)) {
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

/**
 * Shared prompt/tool protocol for CLI-subprocess language models.
 *
 * Both `claude-cli` (`claude --print`) and `codex-cli` (`codex exec`) drive a
 * vendor CLI that authenticates with the user's own subscription login and
 * behaves, for gbrain's purposes, as a text-in/text-out model. Neither CLI
 * exposes the vendor's native function-calling wire format to a caller, so
 * tool use is carried in-band:
 *
 *   1. `buildToolUseInstructions` teaches the model a `<use_tools>[...]
 *      </use_tools>` emission block in the system prompt.
 *   2. `renderPrompt` flattens the ai-sdk message array into one system text
 *      and one user prompt, replaying prior tool calls/results as bracketed
 *      placeholders.
 *   3. `extractToolCalls` parses the block back into ai-sdk `tool-call` parts,
 *      minting gbrain-owned ids (#4155 — never trust model-authored ids).
 *
 * Extracted verbatim from claude-cli-language-model.ts (behavior unchanged)
 * so the codex-cli adapter does not duplicate ~250 lines of protocol code and
 * both providers keep parsing identically. The `idPrefix` argument preserves
 * each provider's historical id prefix (one grep target per provider).
 */
import { randomUUIDv7 } from 'bun';
import type {
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2ProviderDefinedTool,
} from '@ai-sdk/provider';

/**
 * Build the system-prompt addendum that teaches the model the
 * `<use_tools>...</use_tools>` emission format. Returns the empty string
 * when no tools are registered for this turn so the model gets a normal
 * text-completion prompt without protocol noise.
 */
export function buildToolUseInstructions(
  tools: ReadonlyArray<LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool> | undefined,
): string {
  if (!tools || tools.length === 0) return '';

  const functionTools = tools.filter((t): t is LanguageModelV2FunctionTool => t.type === 'function');
  if (functionTools.length === 0) return '';

  const toolSpecs = functionTools.map(t => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  return [
    '',
    '## Tool Use Protocol',
    '',
    'You have access to these tools:',
    '',
    '```json',
    JSON.stringify(toolSpecs, null, 2),
    '```',
    '',
    'To call one or more tools in this turn, emit EXACTLY ONE block of this form, ' +
      'with no other text outside the block on its own lines:',
    '',
    '<use_tools>',
    '[',
    '  {"name": "<tool name>", "input": <input object matching the tool\'s input_schema>}',
    ']',
    '</use_tools>',
    '',
    'Multiple tool calls go in the array. Tool results are returned to you on the ' +
      'next turn as [tool_result <text>] entries. You may then call more tools or emit a final response.',
    '',
    'When you are ready to give a final answer instead of calling tools, respond with prose text only — ' +
      'do not include a <use_tools> block in that case.',
    '',
  ].join('\n');
}

/**
 * Render the ai-sdk message array into a single text prompt for the CLI's
 * stdin. System messages are extracted up-front and concatenated into the
 * system-prompt value. Tool calls and tool results are rendered as
 * placeholders so the model sees the conversation in a coherent shape even
 * though the adapter does not natively round-trip tool calls through the CLI.
 */
export function renderPrompt(prompt: LanguageModelV2Prompt): { systemText: string; userPrompt: string } {
  const systemParts: string[] = [];
  const convo: string[] = [];

  for (const msg of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      const text = msg.content
        .map(p => {
          if (p.type === 'text') return p.text;
          // File parts get a stub — multimodal is not supported via subprocess yet.
          if (p.type === 'file') return `[file ${p.mediaType ?? 'unknown'}]`;
          return '';
        })
        .filter(s => s.length > 0)
        .join('\n');
      if (text) convo.push(`User: ${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      const rendered = msg.content
        .map(p => {
          if (p.type === 'text') return p.text;
          if (p.type === 'reasoning') return ''; // dropped on replay
          if (p.type === 'tool-call') {
            return `[tool_use ${p.toolName}(${p.input})]`;
          }
          if (p.type === 'tool-result') {
            const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
            return `[tool_result ${out}]`;
          }
          return '';
        })
        .filter(s => s.length > 0)
        .join('\n');
      if (rendered) convo.push(`Assistant: ${rendered}`);
      continue;
    }
    if (msg.role === 'tool') {
      const rendered = msg.content
        .map(p => {
          const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
          return `[tool_result ${out}]`;
        })
        .join('\n');
      if (rendered) convo.push(`User: ${rendered}`);
      continue;
    }
  }

  return { systemText: systemParts.join('\n'), userPrompt: convo.join('\n\n') };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  /** Stringified JSON, matching the ai-sdk LanguageModelV2ToolCall.input contract. */
  input: string;
}

/**
 * Keys the `<use_tools>` protocol reserves on an entry. `type: "tool_use"`
 * and a `toolu_*` `id` are tolerated leftovers of the Anthropic tool_use
 * shape; nothing reads them. Any OTHER `type`/`id` value is a real tool
 * argument (e.g. the allowlisted `list_pages` op's `type` filter) and stays.
 */
function isReservedEntryKey(k: string, v: unknown): boolean {
  if (k === 'name' || k === 'input') return true;
  if (k === 'type') return v === 'tool_use';
  if (k === 'id') return typeof v === 'string' && v.startsWith('toolu_');
  return false;
}

/**
 * Resolve the tool input of one `<use_tools>` entry. The protocol asks for
 * `{name, input}`, but the model sometimes emits the arguments flat on the
 * entry itself (`{"name": "brain_search", "query": "..."}`), the Anthropic
 * tool_use shape with the `input` wrapper dropped. Reading only `e.input`
 * turned every such call into `{}`, and the tool then failed on its missing
 * required parameter with nothing the model could act on. When `input` is
 * absent, the entry's non-reserved keys ARE the input; when it is present
 * it wins verbatim, stray sibling keys ignored.
 */
export function resolveEntryInput(e: Record<string, unknown>): unknown {
  if (e.input !== undefined && e.input !== null) return e.input;
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (!isReservedEntryKey(k, v)) flat[k] = v;
  }
  return flat;
}

/**
 * Locate and parse the `<use_tools>...</use_tools>` block in the assistant's
 * raw text response. Returns the parsed tool calls plus whatever prose
 * surrounded the block. Returns an empty `toolCalls` array when no block is
 * present, malformed, or unterminated — the caller then treats the full
 * raw text as a final text response.
 *
 * `idPrefix` is the provider's historical tool-call id prefix
 * (`toolu_claude_cli_`, `toolu_codex_cli_`); `logTag` names the provider in
 * the discarded-call stderr line.
 */
export function extractToolCalls(raw: string, idPrefix: string, logTag: string): {
  toolCalls: ParsedToolCall[];
  beforeText: string;
  afterText: string;
} {
  const openTag = '<use_tools>';
  const closeTag = '</use_tools>';
  // No single anchoring rule survives every shape the model emits: a prose
  // mention of `<use_tools>` BEFORE the block ("Let me use the correct
  // `<use_tools>` format:") breaks anchoring on the first open tag; a prose
  // mention of `</use_tools>` before the block breaks anchoring on the first
  // close tag; and a LITERAL tag inside a JSON string argument (a page body
  // being written that documents the protocol) breaks "last open tag before
  // the close" — the inner tag wins, the slice is truncated JSON, and a
  // valid call is discarded as prose. So: enumerate the (open, close) pairs
  // outermost-first (earliest open, then each later close) and accept the
  // first slice that parses as a JSON array. Tags inside argument strings
  // sit inside an accepted slice or produce a rejected one; they never anchor.
  // ponytail: O(opens × closes) JSON.parse attempts — tags are a handful per
  // response; a linear scanner is the upgrade if a payload ever has hundreds.
  const opens: number[] = [];
  for (let i = raw.indexOf(openTag); i !== -1; i = raw.indexOf(openTag, i + 1)) opens.push(i);
  const closes: number[] = [];
  for (let i = raw.indexOf(closeTag); i !== -1; i = raw.indexOf(closeTag, i + 1)) closes.push(i);

  let parsed: unknown[] | null = null;
  let openIdx = -1;
  let closeIdx = -1;
  let firstError: string | null = null;
  outer: for (const o of opens) {
    for (const c of closes) {
      if (c < o + openTag.length) continue;
      let inner = raw.slice(o + openTag.length, c).trim();
      if (inner.startsWith('```')) {
        inner = inner.replace(/^```(?:json|JSON)?\s*\n?/, '').replace(/\n?```$/, '').trim();
      }
      try {
        const v: unknown = JSON.parse(inner);
        if (Array.isArray(v)) { parsed = v; openIdx = o; closeIdx = c; break outer; }
      } catch (e) {
        firstError ??= e instanceof Error ? e.message : String(e);
      }
    }
  }
  if (parsed === null) {
    // A malformed block is a LOST tool call — the caller sees prose and the
    // turn ends as if the model never called anything. Say so on stderr.
    // (No pair at all — unterminated, absent, or only orphan close tags — and
    // a non-array payload both recover silently as before.)
    if (firstError !== null) {
      process.stderr.write(`[${logTag}] <use_tools> block failed to parse — tool call discarded: ${firstError}\n`);
    }
    return { toolCalls: [], beforeText: raw.trim(), afterText: '' };
  }

  const beforeText = raw.slice(0, openIdx).trim();
  const afterText = raw.slice(closeIdx + closeTag.length).trim();

  const toolCalls: ParsedToolCall[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : null;
    if (!name) continue;
    // #4155: ALWAYS mint — never trust a model-authored id. Each doGenerate
    // is a fresh subprocess replayed from an id-stripped transcript
    // (renderPrompt), so the model structurally CANNOT keep ids unique
    // across turns; it echoed the prompt's example entropy-free (toolu_01,
    // toolu_02 every turn) and collided real dream jobs to death before the
    // job-wide unique constraint was retired (migration v131). The prompt no
    // longer asks for an id; a stray `id` field from older cached behavior
    // is deliberately ignored — nothing round-trips it (renderPrompt strips
    // ids on replay; the loop pairs results in-memory within one turn).
    const id = `${idPrefix}${randomUUIDv7()}`;
    const inputJson = JSON.stringify(resolveEntryInput(e));
    toolCalls.push({ id, name, input: inputJson });
  }

  return { toolCalls, beforeText, afterText };
}

/**
 * Strip a provider prefix (`anthropic:`, `litellm:`, `claude-cli:`,
 * `codex-cli:`) that the underlying CLI does not understand. The gateway
 * hands adapters a bare model id via `recipe.aliases` resolution, but
 * defensive normalization keeps direct LanguageModelV2 construction (in
 * tests, for example) ergonomic.
 */
export function stripProviderPrefix(model: string): string {
  const idx = model.indexOf(':');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

import { createHash } from 'node:crypto';
import { scanText } from '../secret-scan.ts';

export const WRITEBACK_SKIP_REASONS = [
  'empty',
  'too_short',
  'ack_or_greeting',
  'slash_command',
  'question_only',
  'quoted_or_tool_output',
  'bulk_paste',
  'secret',
  'operational_request',
] as const;
export type WritebackSkipReason = (typeof WRITEBACK_SKIP_REASONS)[number];

export type WritebackGateResult =
  | { ok: true; normalized: string; hash24: string }
  | { ok: false; reason: WritebackSkipReason };

export const MIN_TURN_CHARS = 20;
export const MIN_TURN_CHARS_CJK = 10;
export const MAX_TURN_CHARS = 8000;

const CJK_RE = /[\u3000-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\u3040-\u30FF]/;

const ACK_PHRASE =
  '(thanks|thank you|thx|ty|ok(ay)?|k+|sure|yes|yep|yeah|no|nope|got it|sounds good|great|perfect|nice|cool|awesome|good (morning|afternoon|evening|night)|hi|hello|hey|bye|goodbye|see you|lgtm|will do|done|please (do|continue)|go ahead|continue|proceed|stop|cancel|never ?mind|nvm|please|so much|a lot)';
const ACK_RE = new RegExp(`^${ACK_PHRASE}((\\s|,)+${ACK_PHRASE})*$`);

function stripQuotedAndToolOutput(text: string): string {
  let out = text.replace(/```[\s\S]*?(```|$)/g, ' ');
  const lines = out.split('\n');
  const kept: string[] = [];
  let indentRun: string[] = [];
  const flushRun = () => {
    if (indentRun.length > 0 && indentRun.length < 3) kept.push(...indentRun);
    indentRun = [];
  };
  for (const line of lines) {
    if (line.trimStart().startsWith('>')) continue;
    if (/^\s{4,}\S/.test(line)) { indentRun.push(line); continue; }
    flushRun();
    kept.push(line);
  }
  flushRun();
  return kept.join('\n');
}

export function normalizeTurnText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function turnHash24(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24);
}

export function gateWritebackTurn(text: unknown, opts: { minChars?: number; maxChars?: number; maxBytes?: number; excludeOperationalRequests?:boolean } = {}): WritebackGateResult {
  if (typeof text !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  const minChars = opts.minChars ?? (CJK_RE.test(trimmed) ? MIN_TURN_CHARS_CJK : MIN_TURN_CHARS);
  if (trimmed.length < minChars) return { ok: false, reason: 'too_short' };
  if (trimmed.length > (opts.maxChars ?? MAX_TURN_CHARS) || Buffer.byteLength(trimmed,'utf8') > (opts.maxBytes ?? 8192)) return { ok: false, reason: 'bulk_paste' };
  if (scanText(trimmed).length) return { ok: false, reason: 'secret' };
  if (/^(好的|谢谢|感谢|收到|明白|继续|可以|没问题|辛苦了|嗯|好|是的|请继续|[，。！!\s])+$/u.test(trimmed)) return { ok:false,reason:'ack_or_greeting' };
  const bare = trimmed.toLowerCase().replace(/[.!?,;:~……]+$/gu, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  if (bare.split(/\s+/).length <= 6 && ACK_RE.test(bare)) {
    return { ok: false, reason: 'ack_or_greeting' };
  }
  if (trimmed.startsWith('/')) return { ok: false, reason: 'slash_command' };
  const sentences = trimmed
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length > 0 && sentences.every((s) => /[?？]$/.test(s))) {
    const hasClaim=opts.excludeOperationalRequests&&sentences.flatMap(part=>part.split(/[，,；;]/)).some(part=>part.trim().length>=minChars&&!/[?？]$|吗|是否|怎么|如何|多少|能否|what|how|why|where/i.test(part)&&!/^(请|帮我|你能|能不能|可以|并|please|can you|could you)/i.test(part.trim()));
    if(!hasClaim)return { ok: false, reason: 'question_only' };
  }
  const residue = stripQuotedAndToolOutput(trimmed).trim();
  if (residue.length < (opts.minChars ?? (CJK_RE.test(residue) ? MIN_TURN_CHARS_CJK : MIN_TURN_CHARS))) {
    return { ok: false, reason: 'quoted_or_tool_output' };
  }
  const normalized = normalizeTurnText(residue);
  if(opts.excludeOperationalRequests&&!/以后|今后|从今|每次|总是|一律|默认|统一|约定|规则|always|from now on|by default/i.test(normalized)&&residue.split(/[，,；;。！？!?]/).filter(part=>part.trim()).every(part=>/^(请|请问|帮我|给我|给.{0,24}(写|列|生成|查)|替我|能否|可以.{0,6}(帮|查|写)|你能|并?(说明|解释|列出|查询|写一份|生成)|please|can you|could you|help me|show me)/i.test(part.trim())))return {ok:false,reason:'operational_request'};
  return { ok: true, normalized, hash24: turnHash24(normalized) };
}

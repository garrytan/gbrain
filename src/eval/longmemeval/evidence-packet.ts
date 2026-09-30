import type { LongMemEvalTurn } from './adapter.ts';
import { renderChatBlock, sanitizeChatContent } from './sanitize.ts';
import { READER_MAX_SESSION_CHARS } from './reader.ts';
import { sha256Hex, stableStringify } from './run-config.ts';
import { tokenizeTitle } from '../../core/search/title-match.ts';
import { estimateTokens, packToBudget } from '../../core/search/token-budget.ts';

export const PACKET_VERSION = 'experimental-original-rounds-v1';

export interface EvidenceSession {
  source_id: string;
  session_id: string;
  date?: string;
  body: string;
  turns: readonly LongMemEvalTurn[];
}

export interface PassagePointer {
  source_id: string;
  session_id: string;
  turn: number;
  start: number;
  end: number;
  sha256: string;
  role: LongMemEvalTurn['role'];
}

export interface EvidencePacket {
  version: string;
  rendered: string;
  source_hash: string;
  passages: PassagePointer[];
  omitted_turns: Array<{ source_id: string; session_id: string; turns: number[] }>;
  fallback_sessions: string[];
  sanitization: Array<{ source_id: string; session_id: string; matched: string[] }>;
  budget_fallback: boolean;
  estimated_tokens: number;
  preprocessing_cost_usd: number;
}

const STOP = new Set('a an the i me my you your we our it its is are was were be been do did does have has had to of for in on at by as and or with from that this these those what which who when where why how can could would should will please tell know remember mention mentioned about some any'.split(' '));
const QUALIFICATION = /\b(?:actually|instead|no longer|used to|changed|but|except|unless|only|never|prefer\w*|avoid\w*|allerg\w*|rather|not)\b/i;

function attribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function validateEvidence(sessions: readonly EvidenceSession[]): void {
  if (!Array.isArray(sessions)) throw new Error('Evidence sessions must be an array');
  const seen = new Set<string>();
  for (const s of sessions) {
    if (!s || typeof s.source_id !== 'string' || !s.source_id || typeof s.session_id !== 'string' || !s.session_id
      || typeof s.body !== 'string' || !Array.isArray(s.turns) || (s.date !== undefined && typeof s.date !== 'string')) {
      throw new Error('Invalid evidence session');
    }
    if (/[<>&\u0000-\u001f]/u.test(s.session_id + (s.date ?? ''))) throw new Error('Unsafe session metadata');
    if (sanitizeChatContent(s.body, READER_MAX_SESSION_CHARS).matched.includes('length-cap')) throw new Error('Full-session source would be truncated; refuse this experiment input');
    const key = stableStringify([s.source_id, s.session_id]);
    if (seen.has(key)) throw new Error('Duplicate evidence source identity');
    seen.add(key);
    for (const t of s.turns) {
      if (!t || !['user', 'assistant'].includes(t.role) || typeof t.content !== 'string') throw new Error('Invalid evidence turn');
    }
  }
}

export function renderFullSessions(sessions: readonly EvidenceSession[]): string {
  validateEvidence(sessions);
  return renderChatBlock(sessions.map(s => ({ session_id: s.session_id, date: s.date, body: s.body })), {
    maxSessionChars: READER_MAX_SESSION_CHARS,
  }).rendered;
}

export function buildEvidencePacket(
  question: string,
  sessions: readonly EvidenceSession[],
  options: { anchorRounds?: number; adjacentRounds?: number; maxTokens?: number } = {},
): EvidencePacket {
  validateEvidence(sessions);
  if (typeof question !== 'string' || !question.trim()) throw new Error('A nonempty question is required');
  const anchorRounds = options.anchorRounds ?? 2;
  const adjacentRounds = options.adjacentRounds ?? 1;
  if (!Number.isSafeInteger(anchorRounds) || anchorRounds < 1 || anchorRounds > 8
    || !Number.isSafeInteger(adjacentRounds) || adjacentRounds < 0 || adjacentRounds > 2
    || (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 0))) {
    throw new Error('Invalid evidence packet limits');
  }
  const full = renderFullSessions(sessions);
  const budget = options.maxTokens ?? estimateTokens(full);
  if (estimateTokens(full) > budget) throw new Error('Full-session baseline exceeds the common ceiling');
  const terms = [...new Set(tokenizeTitle(question).filter(t => t.length > 2 && !STOP.has(t)))];
  const grouped = sessions.map(s => {
    const rounds: number[][] = [];
    s.turns.forEach((t, i) => {
      if (t.role === 'user' || rounds.length === 0) rounds.push([]);
      rounds[rounds.length - 1].push(i);
    });
    return rounds.map(turns => ({
      turns,
      tokens: new Set(tokenizeTitle(turns.map(i => s.turns[i].content).join('\n'))),
      qualified: turns.some(i => s.turns[i].role === 'user' && QUALIFICATION.test(s.turns[i].content)),
    }));
  });
  const allRounds = grouped.flat();
  const weights = new Map(terms.map(term => [term,
    Math.log(1 + allRounds.length / (1 + allRounds.filter(r => r.tokens.has(term)).length)),
  ]));
  let passages: PassagePointer[] = [];
  let omitted: EvidencePacket['omitted_turns'] = [];
  const fallback: string[] = [];
  const sanitization: EvidencePacket['sanitization'] = [];
  const blocks = sessions.map((s, si) => {
    const rounds = grouped[si];
    const ranked = rounds.map((r, index) => ({ index, score: terms.reduce((n, t) => n + (r.tokens.has(t) ? weights.get(t)! : 0), 0) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = new Set<number>();
    if (!ranked.length || ranked[0].score === 0) {
      rounds.forEach((_, i) => selected.add(i));
      fallback.push(stableStringify([s.source_id, s.session_id]));
    } else {
      for (const r of ranked.filter(r => r.score > 0).slice(0, anchorRounds)) selected.add(r.index);
      for (const term of terms) {
        const best = ranked.find(r => rounds[r.index].tokens.has(term));
        if (best) selected.add(best.index);
      }
      rounds.forEach((r, i) => { if (r.qualified) selected.add(i); });
      for (const i of [...selected]) {
        for (let d = -adjacentRounds; d <= adjacentRounds; d++) {
          if (i + d >= 0 && i + d < rounds.length) selected.add(i + d);
        }
      }
    }
    const kept = new Set([...selected].flatMap(i => rounds[i].turns));
    const dropped = s.turns.map((_, i) => i).filter(i => !kept.has(i));
    omitted.push({ source_id: s.source_id, session_id: s.session_id, turns: dropped });
    const lines = [`Original passages; omitted turn indices: ${JSON.stringify(dropped)}.`];
    s.turns.forEach((t, i) => {
      if (!kept.has(i)) return;
      passages.push({ source_id: s.source_id, session_id: s.session_id, turn: i, start: 0, end: t.content.length, sha256: sha256Hex(t.content), role: t.role });
      lines.push(`Source: ${JSON.stringify([s.source_id, s.session_id, i])}; speaker: ${t.role}; date: ${JSON.stringify(s.date ?? null)}\n${t.content}`);
    });
    if (!dropped.length) {
      sanitization.push({ source_id: s.source_id, session_id: s.session_id, matched: sanitizeChatContent(s.body, READER_MAX_SESSION_CHARS).matched });
      return renderFullSessions([s]);
    }
    const raw = lines.join('\n\n');
    const body = raw.replace(/<\s*\/?\s*chat_session\b[^>]*>/gi, m => `&lt;${m.slice(1, -1)}&gt;`);
    sanitization.push({ source_id: s.source_id, session_id: s.session_id, matched: [
      ...(body !== raw ? ['escape-chat-session-tags'] : []), ...sanitizeChatContent(body, READER_MAX_SESSION_CHARS).matched,
    ] });
    const rendered = renderChatBlock([{ session_id: attribute(s.session_id), date: s.date ? attribute(s.date) : undefined, body }], {
      maxSessionChars: READER_MAX_SESSION_CHARS,
    });
    if (rendered.truncatedCount) return null;
    return rendered.rendered;
  });
  const candidate = blocks.includes(null) ? null : blocks.join('\n\n');
  const fits = candidate !== null && (budget === 0 ? candidate.length === 0 : packToBudget([candidate], estimateTokens, budget).items.length === 1);
  if (!fits) {
    passages = sessions.flatMap(s => s.turns.map((t, i) => ({ source_id: s.source_id, session_id: s.session_id, turn: i, start: 0, end: t.content.length, sha256: sha256Hex(t.content), role: t.role })));
    omitted = sessions.map(s => ({ source_id: s.source_id, session_id: s.session_id, turns: [] }));
    sanitization.splice(0, sanitization.length, ...sessions.map(s => ({ source_id: s.source_id, session_id: s.session_id, matched: sanitizeChatContent(s.body, READER_MAX_SESSION_CHARS).matched })));
  }
  const rendered = fits ? candidate! : full;
  return {
    version: PACKET_VERSION,
    rendered,
    source_hash: sha256Hex(stableStringify(sessions)),
    passages,
    omitted_turns: omitted,
    fallback_sessions: fallback,
    sanitization,
    budget_fallback: !fits,
    estimated_tokens: estimateTokens(rendered),
    preprocessing_cost_usd: 0,
  };
}

import type { Chunk } from '../types.ts';
import { BUILTIN_PATTERNS } from '../conversation-parser/builtins.ts';
import { MAX_CUE_GROUNDING_CHUNKS, MAX_CUE_GROUNDING_SPANS, type CueGroundingSpan, type CueOutput, type CueWindow } from './types.ts';

export const MAX_CUE_WINDOW_BYTES = 8192;

function byteEnd(text: string, start: number, budget: number): number {
  let end = start;
  let bytes = 0;
  while (end < text.length) {
    const character = String.fromCodePoint(text.codePointAt(end)!);
    if (bytes + Buffer.byteLength(character) > budget) break;
    bytes += Buffer.byteLength(character);
    end += character.length;
  }
  return end;
}

function byteStart(text: string, end: number, budget: number): number {
  let start = end;
  let bytes = 0;
  while (start > 0) {
    const size = /[\uDC00-\uDFFF]/.test(text[start - 1]!) && start > 1 ? 2 : 1;
    const character = text.slice(start - size, start);
    if (bytes + Buffer.byteLength(character) > budget) break;
    bytes += Buffer.byteLength(character);
    start -= size;
  }
  return start;
}

export function buildCueWindows(chunks: Pick<Chunk, 'id' | 'chunk_text' | 'modality'>[]): CueWindow[] {
  const mapped: Array<{ id: number; text: string; start: number; end: number }> = [];
  let text = '';
  for (const chunk of chunks) {
    if (!chunk.chunk_text || chunk.modality && chunk.modality !== 'text') continue;
    if (text && !/\s$/.test(text) && !/^\s/.test(chunk.chunk_text)) text += '\n';
    const start = text.length;
    text += chunk.chunk_text;
    mapped.push({ id: chunk.id, text: chunk.chunk_text, start, end: text.length });
  }
  const markers: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    let headerLength = /^(?:User|Assistant|Human|System|Tool):[ \t]*/i.exec(line)?.[0].length;
    for (const pattern of BUILTIN_PATTERNS) {
      if (headerLength !== undefined) break;
      if (pattern.quick_reject && !pattern.quick_reject.test(line)) continue;
      const match = pattern.regex.exec(line);
      if (!match) continue;
      const body = pattern.captures.text_group === undefined ? '' : match[pattern.captures.text_group] ?? '';
      headerLength = body ? line.lastIndexOf(body) : line.length;
    }
    if (headerLength) markers.push({ start: offset, end: offset + headerLength });
    offset += line.length + 1;
  }
  const slice = (from: number, to: number, separatorBefore = ''): CueWindow['spans'] => {
    const spans: CueWindow['spans'] = [];
    let prior = from;
    for (const chunk of mapped) {
      if (chunk.end <= from) continue;
      if (chunk.start >= to) break;
      const first = Math.max(from, chunk.start);
      const last = Math.min(to, chunk.end);
      spans.push({ chunkId: chunk.id, text: text.slice(first, last), start: Array.from(chunk.text.slice(0, first - chunk.start)).length,
        separatorBefore: spans.length ? text.slice(prior, first) : separatorBefore });
      prior = last;
    }
    return spans;
  };
  const windows: CueWindow[] = [];
  for (let start = 0; start < text.length;) {
    const marker = markers.findLast(m => m.start < start);
    const prefix = marker && start >= marker.end ? slice(marker.start, marker.end) : [];
    const prefixText = prefix.map(s => s.separatorBefore + s.text).join('');
    const capacity = MAX_CUE_WINDOW_BYTES - Buffer.byteLength(prefixText) - (prefix.length ? 1 : 0);
    let end = byteEnd(text, start, capacity);
    const splitMarker = markers.find(m => m.start < end && m.end > end);
    if (splitMarker) end = splitMarker.start;
    const turnBoundary = markers.findLast(m => m.start > start && m.start < end);
    if (turnBoundary && end < text.length && Buffer.byteLength(text.slice(start, turnBoundary.start)) >= capacity / 2) end = turnBoundary.start;
    const ids = new Set(prefix.map(s => s.chunkId));
    for (const chunk of mapped) {
      if (chunk.end <= start) continue;
      if (chunk.start >= end) break;
      ids.add(chunk.id);
      if (ids.size > MAX_CUE_GROUNDING_CHUNKS) { end = chunk.start; break; }
    }
    if (end <= start) throw new Error('unsupported_window');
    const spans = [...prefix, ...slice(start, end, prefix.length ? '\n' : '')];
    windows.push({ index: windows.length, spans, text: spans.map(s => s.separatorBefore + s.text).join('') });
    if (end === text.length) break;
    const overlap = Math.min(640, Math.floor(Buffer.byteLength(text.slice(start, end)) * 0.8));
    let next = Math.max(start + String.fromCodePoint(text.codePointAt(start)!).length, byteStart(text, end, overlap));
    const nextMarker = markers.find(m => m.start < next && m.end > next);
    if (nextMarker) next = nextMarker.start > start ? nextMarker.start : nextMarker.end;
    start = next;
  }
  return windows;
}

export function groundCueQuote(window: CueWindow, quote: string): CueGroundingSpan[] | null {
  const first = window.text.indexOf(quote);
  if (first < 0) return null;
  const last = first + quote.length;
  const grounding: CueGroundingSpan[] = [];
  let cursor = 0;
  let covered = first;
  for (const span of window.spans) {
    cursor += span.separatorBefore.length;
    const from = Math.max(first, cursor);
    const to = Math.min(last, cursor + span.text.length);
    if (from < to) {
      const separator = window.text.slice(covered, from);
      if (!grounding.length && separator) return null;
      const start = span.start + Array.from(span.text.slice(0, from - cursor)).length;
      const end = start + Array.from(span.text.slice(from - cursor, to - cursor)).length;
      const prior = grounding.at(-1);
      if (prior && prior.chunk_id === span.chunkId && prior.end === start && !separator) prior.end = end;
      else grounding.push({ chunk_id: span.chunkId, start, end, separator });
      covered = to;
    }
    cursor += span.text.length;
  }
  if (covered !== last || !grounding.length || grounding.length > MAX_CUE_GROUNDING_SPANS
    || new Set(grounding.map(s => s.chunk_id)).size > MAX_CUE_GROUNDING_CHUNKS) return null;
  return grounding;
}

const APPLICATION_RELATIONS = ['explicit_constraint_applies', 'explicit_preference_applies', 'explicit_commitment_followup', 'stated_goal_tradeoff'];
const PROFILE = /\b(diagnos\w*|personality|psycholog\w*|mentally ill|chronic fatigue|introvert\w*|extrovert\w*|neurotic\w*|narciss\w*|sexual orientation|political affiliation|religious belief)\b/i;

export function validateCueOutput(output: unknown, window: CueWindow, includeBridge = false): CueOutput[] {
  if (!Array.isArray(output) || output.length > 4) throw new Error('invalid_output');
  let scenes = 0;
  let associative = 0;
  return output.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_output');
    const cue = value as CueOutput;
    if (!['scene', 'horizon', ...(includeBridge ? ['bridge'] : [])].includes(cue.family)
      || typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 240
      || typeof cue.quote !== 'string' || cue.quote.length < 3 || cue.quote.length > 640
      || !groundCueQuote(window, cue.quote) || PROFILE.test(cue.text)) throw new Error('unsupported_cue');
    const allowed = cue.family === 'scene' ? ['situation_description'] : [...APPLICATION_RELATIONS, ...(cue.family === 'bridge' ? ['category_generalization'] : [])];
    if (!allowed.includes(cue.relation) || (cue.family === 'scene' ? ++scenes > 1 : ++associative > 3)) throw new Error('unsupported_relation');
    return { family: cue.family, relation: cue.relation, quote: cue.quote, text: cue.text.trim() };
  });
}

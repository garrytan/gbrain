/**
 * A streamed, seeded conversation-like Markdown file of exactly `bytes` bytes (the Wave C large-page bench,
 * scripts/bench-large-pages.ts, and its tests): frontmatter, day headers and speaker turns between placeholder names,
 * written through one reused 1 MiB buffer so memory stays flat at any size, with its sha256 taken on the way. A unique needle
 * word is planted in the first turn at or past each tenth of the file (10 needles) and its byte offset recorded. ASCII
 * only, no gbrain fences, NUL bytes or real names; the same seed gives the same bytes. The one-string
 * `conversation-page.ts` stays for its existing callers.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';

const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer',
  'review', 'deploy', 'support', 'contract', 'migration', 'onboarding', 'feedback', 'forecast', 'incident', 'partner'];
const SPEAKERS = ['alice-example', 'bob-example', 'carol-example'];
const CHUNK_BYTES = 1024 ** 2;

export interface ConversationNeedle { decile: number; word: string; offset: number }
export interface ConversationFile { path: string; bytes: number; seed: number; sha256: string; needles: ConversationNeedle[] }

/** The turns of `seed`'s conversation, one per call; a turn given `needle` carries it as its middle word. */
export function conversationTurns(seed: number): (needle?: string) => string {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
  let day = 0;
  return needle => {
    const words = Array.from({ length: 12 + Math.floor(next() * 60) }, () => WORDS[Math.floor(next() * WORDS.length)]!);
    if (needle) words.splice(Math.floor(words.length / 2), 0, needle);
    const header = day === 0 || next() < 0.02 ? `## Day ${++day}\n\n` : '';
    return `${header}**${SPEAKERS[Math.floor(next() * SPEAKERS.length)]}**: ${words.join(' ')}.\n\n`;
  };
}

/** Writes the file (needles `gbneedle<decile>s<seed>`); the last turn is cut so it is exactly `bytes` long and ends in a newline. */
export function writeConversationFile(path: string, bytes: number, seed: number): ConversationFile {
  if (bytes < 64 * 1024) throw new RangeError(`writeConversationFile: ${bytes} bytes is below the 64 KiB floor`);
  const hash = createHash('sha256');
  const needles: ConversationNeedle[] = [];
  const turn = conversationTurns(seed);
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const fd = openSync(path, 'w');
  try {
    let used = chunk.write(`---\ntitle: Conversation log ${seed}\ntype: note\n---\n\n`, 'latin1');
    let written = 0;
    const flush = () => { hash.update(chunk.subarray(0, used)); writeSync(fd, chunk, 0, used); written += used; used = 0; };
    while (written + used < bytes - 1) {
      let text: string;
      if (needles.length < 10 && written + used >= Math.floor(bytes * needles.length / 10)) {
        const word = `gbneedle${needles.length}s${seed}`;
        text = turn(word);
        needles.push({ decile: needles.length, word, offset: written + used + text.indexOf(word) });
      } else text = turn();
      for (let from = 0; from < text.length && written + used < bytes - 1;) {
        if (used === CHUNK_BYTES) flush();
        const n = chunk.write(text.slice(from, from + Math.min(CHUNK_BYTES - used, bytes - 1 - written - used)), used, 'latin1');
        used += n; from += n;
      }
    }
    if (used === CHUNK_BYTES) flush();
    chunk[used++] = 0x0a;
    flush();
  } finally { closeSync(fd); }
  return { path, bytes, seed, sha256: hash.digest('hex'), needles };
}

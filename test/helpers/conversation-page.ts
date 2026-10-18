/**
 * A seeded conversation-like Markdown page of about `bytes` UTF-8 bytes (Wave B
 * large-page tests and `scripts/bench-large-pages.ts`): day headers, speaker
 * turns between placeholder names, paragraphs of varied length, now and then a
 * fenced code block, and an optional unique needle word at chosen fractions of
 * the body. No gbrain fences, NUL bytes or real names. Deterministic per seed.
 */
const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer',
  'review', 'deploy', 'support', 'contract', 'migration', 'onboarding', 'feedback', 'forecast', 'incident', 'partner'];
const SPEAKERS = ['alice-example', 'bob-example', 'carol-example'];

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** The body only (no frontmatter); needles land at the first turn past each fraction. */
export function conversationBody(bytes: number, opts: { seed?: number; needles?: ReadonlyArray<{ at: number; word: string }> } = {}): string {
  const next = rng(opts.seed ?? 42);
  const pending = [...(opts.needles ?? [])].sort((a, b) => a.at - b.at);
  const parts: string[] = [];
  let size = 0;
  let day = 0;
  while (size < bytes) {
    let turn = '';
    if (size === 0 || next() < 0.02) turn += `## Day ${++day}\n\n`;
    const words = Array.from({ length: 12 + Math.floor(next() * 60) }, () => WORDS[Math.floor(next() * WORDS.length)]);
    if (pending.length && size >= pending[0]!.at * bytes) words.splice(Math.floor(words.length / 2), 0, pending.shift()!.word);
    turn += `**${SPEAKERS[Math.floor(next() * SPEAKERS.length)]}**: ${words.join(' ')}.\n\n`;
    if (next() < 0.03) turn += '```ts\nconst total = items.reduce((sum, item) => sum + item.value, 0);\n```\n\n';
    parts.push(turn);
    size += Buffer.byteLength(turn, 'utf8');
  }
  return parts.join('').trimEnd();
}

/** A whole file: frontmatter (title, type note) plus `conversationBody`. */
export function conversationPage(bytes: number, opts: { seed?: number; title?: string; needles?: ReadonlyArray<{ at: number; word: string }> } = {}): string {
  return `---\ntitle: ${opts.title ?? 'Conversation log'}\ntype: note\n---\n\n${conversationBody(bytes, opts)}\n`;
}

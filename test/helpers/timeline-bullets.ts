/**
 * A descending timeline of uniform bullets (placeholder sources and names), the shape where the recursive chunker's
 * greedy 300-word packing moves every passage boundary when an entry is added at the top (#7172 follow-up).
 * Used by test/large-pages/timeline-bullet-chunks.test.ts and test/large-pages/timeline-top-insert-reembed.test.ts.
 */
import { mulberry32 } from './seeded-random.ts';

const WORDS = ('launch pricing roadmap hiring metrics retention design latency budget customer review shipped meeting '
  + 'acme-example alice-example partner deck notes').split(' ');

/** One bullet dated by `day` (days after 2020-01-01), 18 to 23 filler words after the date and source. */
export function timelineBullet(r: () => number, day: number): string {
  const date = new Date(Date.UTC(2020, 0, 1 + day)).toISOString().slice(0, 10);
  return `- **${date}** | source-a — ${Array.from({ length: 18 + Math.floor(r() * 6) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ')}`;
}

/** `n` bullets newest first, and the entry a later write adds above them. */
export function descendingTimeline(seed: number, n = 55): { bullets: string[]; top: string } {
  const r = mulberry32(seed);
  const bullets = Array.from({ length: n }, (_, i) => timelineBullet(r, 1000 - i));
  return { bullets, top: timelineBullet(r, 1001) };
}

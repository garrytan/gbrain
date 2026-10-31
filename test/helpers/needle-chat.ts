/**
 * N14's 24 MiB needle layout reduced to a one-day chat (placeholder speakers, invented place name): the chat line shape
 * of the N14 conversation generator, and the seed and message position at which the version-4 segmented chunker's hard
 * cap split the needle sentence across two chunks. Used by test/large-pages/needle-sentence-chunk.test.ts and
 * test/helpers/rechunk-segmented-cases.ts.
 */
import { mulberry32 } from './seeded-random.ts';

const SPEAKERS = ['alice-example', 'bob-example', 'carol-example', 'dave-example'];
const WORDS = ('soon fine call sure coffee into book pretty tonight off apparently walk by good know lunch bakery short tell great from need '
  + 'definitely bike finish see basically to on today big maybe umbrella feel just even café naïve crème über 日曜日 🙂 👍 ☕ déjà').split(' ');
export const NEEDLE = 'the Fennmere harbor pilot is carol-example';

/** A one-day chat in N14's line shape: `lines` messages four minutes apart, the needle sentence as message `at` (-1: none). */
export function needleChat(seed: number, lines: number, at: number, day = '2018-12-29'): string {
  const r = mulberry32(seed);
  const out = [`## ${day}`, ''];
  for (let i = 0; i < lines; i++) {
    const who = SPEAKERS[Math.floor(r() * SPEAKERS.length)];
    const min = 7 * 60 + i * 4;
    const stamp = `(${day} ${((Math.floor(min / 60) + 11) % 12) + 1}:${String(min % 60).padStart(2, '0')} ${min < 720 ? 'AM' : 'PM'})`;
    const text = i === at ? `noting here that ${NEEDLE}` : Array.from({ length: 2 + Math.floor(r() * 18) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
    out.push(`**${who}** ${stamp}: ${text}`);
  }
  return out.join('\n') + '\n';
}

/** N14's reduction: under the old cuts the hard cap's window ends inside the needle line. */
export const N14_REDUCED = needleChat(1, 62, 60);


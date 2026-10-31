/**
 * A child process for test/conversation-parser/pattern-detector.test.ts (N6): feeds createPatternDetector a head, 40
 * fresh 1 MiB pieces and a tail, and prints the most heap it retained after any piece (a full GC before each reading)
 * and the pattern it detected. Run in its own process so each forced GC scans only this heap, never what other test
 * files in the same bun process left behind. Argument: 'line' (a 40 MiB line with no newline) or 'block' (a block
 * message whose 40 MiB body is 1 KiB lines).
 */
import { heapSize } from 'bun:jsc';
import { createPatternDetector } from '../../src/core/conversation-parser/parse.ts';

const MIB = 1024 ** 2;
const transcript = Array.from({ length: 60 }, (_, t) => `**${t % 2 ? 'Alice' : 'Bob'}** (${1 + (t % 11)}:0${t % 10} PM): turn ${t} about the roadmap review.`).join('\n');
const line = (i: number, j: number) => `  body line ${j} of piece ${i} `.padEnd(1023, 'x');
const cases = {
  line: { head: `${transcript}\n`, piece: (i: number) => String.fromCharCode(97 + (i % 26)).repeat(MIB - 8) + String(i).padStart(8, '0'), tail: `\n${transcript}\n` },
  block: { head: '- **Theo** (Mon 11:18)\n', piece: (i: number) => Array.from({ length: 1024 }, (_, j) => `${line(i, j)}\n`).join(''), tail: '- **Juan** (11:20 AM)\n  done\n' },
};
const { head, piece, tail } = cases[process.argv[2] as keyof typeof cases];
const detector = createPatternDetector();
detector.push(head);
Bun.gc(true);
const base = heapSize();
let peak = 0;
for (let i = 0; i < 40; i++) {
  detector.push(piece(i));
  Bun.gc(true);
  peak = Math.max(peak, heapSize() - base);
}
detector.push(tail);
process.stdout.write(JSON.stringify({ peak, pattern: detector.finish() }));

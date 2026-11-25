/**
 * One contender for test/shadow-write-compare.test.ts ("stale lock takeover"): takes the lock at argv[2] through withLock, and inside it reads the
 * counter file (argv[3]), pauses, and writes it back with its own name added, logging `enter` and `exit` lines (argv[4]). With argv[5] set it is
 * the slow-to-decide contender: right after it judges the lock dead it writes `<argv[5]>.judged` and waits, up to 5 s, for the file argv[5] to appear
 * before it goes on (the injected hook that puts the other contender's whole takeover between this one's judgment and its unlink).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { withLock } from '../../src/shadow/evidence-epoch.ts';

const [lock, counter, log, barrier] = process.argv.slice(2) as [string, string, string, string | undefined];
const name = process.argv[6] ?? 'B';
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

withLock(lock, () => {
  appendFileSync(log, `enter ${name}\n`);
  const seen = JSON.parse(readFileSync(counter, 'utf8')) as string[];
  pause(300);
  writeFileSync(counter, JSON.stringify([...seen, name]));
  appendFileSync(log, `exit ${name}\n`);
}, { afterJudged: barrier ? () => {
  writeFileSync(`${barrier}.judged`, '1');
  for (let i = 0; i < 250 && !existsSync(barrier); i++) pause(20);
} : undefined });

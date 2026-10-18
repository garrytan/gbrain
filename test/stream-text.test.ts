import { expect, test } from 'bun:test';
import { pumpText, waitForText } from './helpers/stream-text.ts';

// A child that is quiet for longer than a second and then prints the line we wait for in one chunk:
// the pinned OpenClaw gateway does this between loading its plugins and `[gateway] ready`.
const bursty = () => Bun.spawn(['sh', '-c', 'printf "[gateway] starting...\\n"; sleep 1.5; printf "[gateway] ready\\n"; sleep 2'], { stdout: 'pipe', stderr: 'ignore' });

test('pumpText keeps every chunk a child writes after a silence; the ready line is seen', async () => {
  const child = bursty();
  const log = pumpText(child.stdout);
  try {
    expect(await waitForText(log, '[gateway] ready', 10_000)).toBe(true);
    expect(log.text).toBe('[gateway] starting...\n[gateway] ready\n');
  } finally {
    child.kill();
    await child.exited;
  }
}, 20_000);

test('racing reader.read() against a timer loses the chunk that arrives after the silence (the pattern pumpText replaces)', async () => {
  const child = bursty();
  const reader = child.stdout.getReader();
  let log = '';
  const readyBy = Date.now() + 4_000;
  try {
    while (!log.includes('[gateway] ready') && Date.now() < readyBy) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(1_000).then(() => null)]);
      if (chunk?.done) break;
      if (chunk?.value) log += new TextDecoder().decode(chunk.value);
    }
  } finally {
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
  expect(log).toBe('[gateway] starting...\n');
}, 20_000);

import { describe, expect, test } from 'bun:test';
import { inlineCodeEndAt, scanMarkdownCode, type MarkdownCodeMap } from '../src/core/fence-scan.ts';
import { stripCodeBlocks } from '../src/core/markdown-code.ts';

/** The per-character stripCodeBlocks the slice-copying version replaced, kept verbatim as the oracle. */
function referenceStripCodeBlocks(content: string, opts: { onHtmlComment?: (start: number, end: number) => void } = {}): string {
  let fence: string | undefined;
  let inline: MarkdownCodeMap | undefined;
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (i === 0 || content[i - 1] === '\n') {
      const newline = content.indexOf('\n', i);
      const end = newline === -1 ? content.length : newline + 1;
      const line = content.slice(i, end);
      const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
      if (fence || (marker && (marker[1][0] === '~' || !marker[2].includes('`')))) {
        if (!fence) fence = marker![1];
        else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
        out += line.replace(/[^\r\n]/g, ' ');
        i = end;
        continue;
      }
    }
    if (opts.onHtmlComment && content.startsWith('<!--', i)) {
      const close = content.indexOf('-->', i + 4);
      const end = close === -1 ? content.length : close + 3;
      opts.onHtmlComment(i, end);
      out += content.slice(i, end).replace(/[^\r\n]/g, ' ');
      i = end;
      continue;
    }
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3);
      const afterFence = end === -1 ? content.length : end + 3;
      out += content.slice(i, afterFence).replace(/[^\r\n]/g, ' ');
      i = afterFence;
      continue;
    }
    if (content[i] === '`') {
      inline ??= scanMarkdownCode(content.replace(/\r(?!\n)/g, ' '));
      const end = inlineCodeEndAt(inline, i);
      if (end === -1) {
        out += content[i];
        i++;
        continue;
      }
      out += content.slice(i, end).replace(/[^\r\n]/g, ' ');
      i = end;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  '`', '`', '`', '``', '```', '````', '~', '~~~', '~~~~', ' ', ' ', '   ', '    ', '\n', '\n', '\r\n', '\r', '\t',
  '<!--', '-->', '<!-', '--', '<', '>', '-', 'a', 'b', 'x', 'js', 'Z', '1', '#', '* ', '\\', '|', '.', 'é', '中', '😀', '𝔸',
];

function randomMarkdown(r: () => number): string {
  const n = Math.floor(r() * 80);
  let s = '';
  for (let k = 0; k < n; k++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return s;
}

function both(input: string, withComments: boolean) {
  const run = (fn: typeof stripCodeBlocks) => {
    const calls: Array<[number, number]> = [];
    const out = fn(input, withComments ? { onHtmlComment: (s, e) => calls.push([s, e]) } : {});
    return { out, calls };
  };
  return { actual: run(stripCodeBlocks), expected: run(referenceStripCodeBlocks) };
}

describe('stripCodeBlocks matches the per-character reference', () => {
  test('fuzz: output and onHtmlComment calls are identical', () => {
    const r = rng(6844);
    for (let k = 0; k < 40_000; k++) {
      const input = randomMarkdown(r);
      for (const withComments of [false, true]) {
        const { actual, expected } = both(input, withComments);
        if (actual.out !== expected.out || JSON.stringify(actual.calls) !== JSON.stringify(expected.calls)) {
          throw new Error(`mismatch (comments=${withComments}) on ${JSON.stringify(input)}`);
        }
        expect(actual.out.length).toBe(input.length);
      }
    }
  });

  test('fixtures: fences, CR line endings, unclosed spans and comments', () => {
    const fixtures = [
      '',
      'plain text with no code',
      '```ts\nconst a = 1;\n```\nafter `inline` and ``a `b` c`` done',
      '~~~\ncode ``` inside\n~~~~\nprose',
      '````\n```\nstill code\n````\nout',
      '```js `x`\nnot a fence ``` closes here\n',
      '  ```\r\nfenced\r\n  ```\r\nafter\r\n',
      'a `b\rc` d\r```\r~~~\rtext',
      '<!-- note `x` -->\n```\n<!-- inside -->\n```\n<!-- unclosed',
      '`unclosed inline\n```unclosed triple',
      '    ```\nindented four is not a fence\n```',
      '😀 `𝔸` 中文 ~~~\n~~~ 😀\n𝔸\n~~~',
    ];
    for (const input of fixtures) {
      for (const withComments of [false, true]) {
        const { actual, expected } = both(input, withComments);
        expect(actual).toEqual(expected);
      }
    }
  });

  test('large mixed documents are identical', () => {
    const r = rng(68);
    for (let k = 0; k < 50; k++) {
      let doc = '';
      while (doc.length < 20_000) doc += randomMarkdown(r) + (r() < 0.2 ? '\n```py\nprint(1)\n```\n' : ' words and more words. ');
      for (const withComments of [false, true]) {
        const { actual, expected } = both(doc, withComments);
        expect(actual).toEqual(expected);
      }
    }
  });
});

import { expect, test } from 'bun:test';

import { extractBody } from '../src/core/google/google-clients.ts';
import { htmlToText } from '../src/core/google/google-render.ts';

const b64url = (s: string): string => Buffer.from(s, 'utf-8').toString('base64url');

test('an HTML document labelled text/plain is flagged as markup', () => {
  const doc = '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>Hello team</p></body></html>';
  const out = extractBody({ mimeType: 'text/plain', body: { data: b64url(doc) } });
  const body = out.isHtml ? htmlToText(out.text) : out.text;
  expect(out.isHtml).toBe(true);
  expect(body).toBe('Hello team');
});

test('a genuine plain part is kept as plain text', () => {
  const out = extractBody({
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('plain body wins') } },
      { mimeType: 'text/html', body: { data: b64url('<p>html body loses</p>') } },
    ],
  });
  expect(out).toEqual({ text: 'plain body wins', isHtml: false });
});

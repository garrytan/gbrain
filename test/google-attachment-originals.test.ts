import { expect, test } from 'bun:test';
import { GmailClient } from '../src/core/google/google-clients.ts';
import { renderThreadPage } from '../src/core/google/google-render.ts';

const account = 'reader@example.invalid';
const original = 'Fictional care original. Quantity 2 teaspoons at 18:30 America/Los_Angeles. '.padEnd(818, 'x');
const raw = (remote: boolean, mimeType = 'text/plain', size = 818) => ({ id: 'thread123', messages: [{
  id: 'message123', internalDate: '1790000000000', labelIds: ['INBOX'], payload: {
    mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'provider@example.invalid' },
      { name: 'To', value: account }, { name: 'Subject', value: 'Care original' }], parts: [
      { partId: '0', mimeType: 'text/plain', body: { data: Buffer.from('See original.').toString('base64url') } },
      { partId: '1', mimeType, filename: 'care.txt', body: { size,
        ...(remote ? { attachmentId: 'ephemeral-handle' } : { data: Buffer.from(original).toString('base64url') }) } },
    ],
  },
}] });

function client(data: ReturnType<typeof raw>, fail = false) {
  const requests: string[] = [];
  const tokens = { getAccessToken: async () => 'synthetic-test-token', forceRefresh: async () => {} };
  const c = new GmailClient(tokens as any, async url => {
    requests.push(String(url));
    if (String(url).includes('/attachments/')) {
      if (fail) throw new Error('synthetic download failed');
      return Response.json({ data: Buffer.from(original).toString('base64url'), size: 818 });
    }
    return Response.json(data);
  });
  return { c, requests };
}

for (const remote of [false, true]) {
  test(`818-byte ${remote ? 'remote' : 'inline'} text original reaches the rendered indexed page`, async () => {
    const { c, requests } = client(raw(remote));
    const thread = await c.getThread('thread123', account);
    const receipt = thread.messages[0].attachmentInspection!.attachments[0];
    expect(receipt).toMatchObject({ fetched: true, indexed: false, attachmentId: null, size: 818 });
    const page = renderThreadPage(thread)!;
    expect(page.markdown).toContain(original);
    expect(page.markdown).toContain('downloaded; indexed in this page');
    expect(receipt.indexed).toBe(true);
    expect(page.markdown).toContain(receipt.sha256!);
    expect(requests.filter(u => u.includes('/attachments/'))).toHaveLength(remote ? 1 : 0);
    expect(page.markdown).not.toContain('ephemeral-handle');
  });
}

test('metadata-only repair makes no attachment download and no false indexing claim', async () => {
  const { c, requests } = client(raw(true));
  const thread = await c.getThread('thread123', account, { metadataOnly: true });
  expect(thread.messages[0].attachmentInspection!.attachments[0]).toMatchObject({ fetched: false, indexed: false });
  expect(requests).toHaveLength(1);
});

test('failed original retrieval stays explicit without invented source text', async () => {
  const { c } = client(raw(true), true);
  const thread = await c.getThread('thread123', account);
  const page = renderThreadPage(thread)!;
  expect(page.markdown).not.toContain(original);
  expect(thread.messages[0].attachmentInspection!.attachments[0]).toMatchObject({ fetched: false, indexed: false, unavailable: 'download_or_decode_failed' });
});

test('oversize and unsupported attachments are never downloaded', async () => {
  for (const data of [raw(true, 'text/plain', 65537), raw(true, 'application/pdf')]) {
    const { c, requests } = client(data);
    const thread = await c.getThread('thread123', account);
    expect(thread.messages[0].attachmentInspection!.attachments[0].fetched).toBe(false);
    expect(requests).toHaveLength(1);
  }
});

test('binary and truncated text cannot be marked fetched or indexed', async () => {
  const data = raw(false);
  data.messages[0].payload.parts[1].body.data = Buffer.from([0xff, 0xfe]).toString('base64url');
  const { c } = client(data);
  const thread = await c.getThread('thread123', account);
  expect(thread.messages[0].attachmentInspection!.attachments[0]).toMatchObject({ fetched: false, indexed: false });
});

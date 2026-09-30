import { describe, expect, test } from 'bun:test';
import { GmailClient } from '../src/core/google/google-clients.ts';
import { renderThreadPage } from '../src/core/google/google-render.ts';
import { GMAIL_MIME_LIMITS, inspectGmailAttachments, renderAttachmentInspection, type GmailMimePart } from '../src/core/google/attachment-receipts.ts';

const tokens = { getAccessToken: async () => 'synthetic', forceRefresh: async () => 'synthetic' };

type SelectedFields = { [key: string]: SelectedFields | null };

function projectedMetadata(url: string, payload: GmailMimePart) {
  const request = new URL(url);
  expect(request.pathname).toBe('/gmail/v1/users/me/threads/abcdef');
  expect(request.searchParams.get('format')).toBe('full');
  const fields = request.searchParams.get('fields')!;
  expect(fields).toBeTruthy();
  let offset = 0;
  const parse = (): SelectedFields => {
    const selected: SelectedFields = {};
    while (offset < fields.length && fields[offset] !== ')') {
      const name = /^[A-Za-z]+/.exec(fields.slice(offset))?.[0];
      if (!name) throw new Error('Unexpected partial-response selector');
      offset += name.length;
      selected[name] = null;
      if (fields[offset] === '(') {
        offset++;
        selected[name] = parse();
        expect(fields[offset++]).toBe(')');
      }
      if (fields[offset] !== ',') break;
      offset++;
    }
    return selected;
  };
  const selected = parse();
  expect(offset).toBe(fields.length);
  expect(Object.keys(selected).sort()).toEqual(['id', 'messages']);
  expect(Object.keys(selected.messages!).sort()).toEqual(['id', 'internalDate', 'labelIds', 'payload']);
  let part = selected.messages!.payload!;
  for (let depth = 0; depth <= GMAIL_MIME_LIMITS.depth; depth++) {
    expect(Object.keys(part).sort()).toEqual(['body', 'filename', 'headers', 'mimeType', 'partId', 'parts']);
    expect(part.body).toEqual({ attachmentId: null, size: null });
    expect(part.headers).toEqual({ name: null, value: null });
    part = part.parts!;
  }
  expect(part).toEqual({ partId: null, mimeType: null });
  const project = (value: any, selector: SelectedFields): any => Array.isArray(value)
    ? value.map(item => project(item, selector))
    : Object.fromEntries(Object.entries(selector).filter(([key]) => value[key] !== undefined)
      .map(([key, children]) => [key, children ? project(value[key], children) : value[key]]));
  const wire = JSON.stringify(project({ id: 'abcdef', messages: [{ id: '123abcdef4567890', internalDate: '1700000000000', payload }] }, selected));
  expect(wire).not.toContain('INLINE_BODY_SENTINEL');
  expect(wire).not.toContain('"data":');
  return new Response(wire, { headers: { 'content-type': 'application/json' } });
}

async function thread(payload: unknown, account = 'reader@example.com') {
  const urls: string[] = [];
  const client = new GmailClient(tokens, async (url) => {
    urls.push(url);
    return Response.json({ id: 'abcdef', messages: [{ id: '123abcdef4567890', internalDate: '1700000000000', payload }] });
  });
  const result = await client.getThread('abcdef', account);
  expect(urls).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/threads/abcdef?format=full']);
  return result;
}

describe('Gmail attachment receipts', () => {
  test('historical MIME requests project metadata at every depth without transferring inline body data', async () => {
    let calls = 0;
    const client = new GmailClient(tokens, async url => {
      calls++;
      return projectedMetadata(url, { partId: '', mimeType: 'multipart/mixed', body: { data: 'INLINE_BODY_SENTINEL' }, parts: [
        { partId: '0', mimeType: 'text/plain', body: { data: 'INLINE_BODY_SENTINEL', size: 20 } },
        { partId: '1', mimeType: 'multipart/mixed', parts: [
          { partId: '1.0', filename: 'nested.pdf', mimeType: 'application/pdf', body: { data: 'INLINE_BODY_SENTINEL', attachmentId: 'opaque', size: 42 } },
        ] },
      ] });
    });
    const result = await client.getThread('abcdef', 'reader@example.com', { metadataOnly: true });
    expect(calls).toBe(1);
    expect(result.messages[0].bodyText).toBe('');
    expect(result.messages[0].attachmentInspection).toMatchObject({ state: 'present', attachments: [
      { partId: '1.0', filename: 'nested.pdf', attachmentId: 'opaque', size: 42, fetched: false, indexed: false },
    ] });
  });

  test('projected depth sentinel distinguishes overflow from a complete MIME leaf', async () => {
    for (const depth of [GMAIL_MIME_LIMITS.depth, GMAIL_MIME_LIMITS.depth + 1, GMAIL_MIME_LIMITS.depth + 4]) {
      let payload: GmailMimePart = { partId: 'leaf', mimeType: 'text/plain', body: { data: 'INLINE_BODY_SENTINEL' } };
      for (let n = 0; n < depth; n++) payload = { partId: `node${n}`, mimeType: 'multipart/mixed', parts: [payload] };
      const client = new GmailClient(tokens, async url => projectedMetadata(url, payload));
      const result = await client.getThread('abcdef', 'reader@example.com', { metadataOnly: true });
      expect(result.messages[0].attachmentInspection).toMatchObject(depth > GMAIL_MIME_LIMITS.depth
        ? { state: 'incomplete', reason: 'depth_limit', attachments: [] }
        : { state: 'none', attachments: [] });
    }
  });

  test('projected wide MIME metadata still reports incomplete inspection', async () => {
    const client = new GmailClient(tokens, async url => projectedMetadata(url, { partId: '', mimeType: 'multipart/mixed',
      parts: Array.from({ length: GMAIL_MIME_LIMITS.parts + 1 }, (_, n) => ({ partId: String(n), mimeType: 'text/plain', body: { data: 'INLINE_BODY_SENTINEL' } })),
    }));
    const result = await client.getThread('abcdef', 'reader@example.com', { metadataOnly: true });
    expect(result.messages[0].attachmentInspection).toMatchObject({ state: 'incomplete', reason: 'part_limit' });
  });

  test('historical metadata response limits cancel oversized decoded streams before JSON parsing', async () => {
    let cancelled = false;
    let reads = 0;
    const client = new GmailClient(tokens, async url => {
      expect(new URL(url).searchParams.has('fields')).toBe(true);
      return new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(256 * 1024)); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-encoding': 'gzip', 'content-length': '1' } });
    });
    await expect(client.getThread('abcdef', 'reader@example.com', { metadataOnly: true })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(13);
  });

  test('normalizer and renderer retain attachment metadata without downloading bytes', async () => {
    const result = await thread({ mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'sender@example.com' }], parts: [
      { mimeType: 'text/plain', body: { data: 'SGVsbG8=' } },
      { partId: '1', mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'opaque-id', size: 42 } },
    ] });
    expect(result.messages[0].attachmentInspection).toMatchObject({ state: 'present', attachments: [
      { filename: 'report.pdf', mimeType: 'application/pdf', size: 42, attachmentId: 'opaque-id', partId: '1', fetched: false, indexed: false },
    ] });
    expect(result.messages[0].bodyText).toBe('Hello');
    const rendered = renderThreadPage(result)!.markdown;
    expect(rendered).toContain('report.pdf');
    expect(rendered).toContain('not downloaded; not indexed');
  });

  test('four inspection states stay distinct and missing payload never means no attachments', async () => {
    expect(renderAttachmentInspection()).toBe('Attachments: not inspected.');
    expect(inspectGmailAttachments(undefined, 'reader@example.com', 'message').state).toBe('incomplete');
    expect(inspectGmailAttachments({}, 'reader@example.com', 'message')).toEqual({ state: 'incomplete', reason: 'malformed_part', attachments: [] });
    const result = await thread({ mimeType: 'text/plain', body: { data: 'SGVsbG8=' } });
    expect(result.messages[0].attachmentInspection).toEqual({ state: 'none', attachments: [] });
    expect(renderAttachmentInspection(result.messages[0].attachmentInspection)).toContain('inspected; none found');
  });

  test('nested duplicate names retain account/message/part identities and classify inline and calendar parts', () => {
    const payload = { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: 'SGk=' } }, { mimeType: 'text/html', body: { data: 'SGk=' } }] },
      { filename: 'same.pdf', mimeType: 'application/pdf', body: { size: 10 } },
      { filename: 'same.pdf', mimeType: 'application/pdf', body: { size: 11 } },
      { filename: '', mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<image>' }], body: { attachmentId: 'inline', size: 9 } },
      { mimeType: 'text/calendar', body: { size: 20 } },
    ] };
    const a = inspectGmailAttachments(payload, 'reader@example.com', 'one');
    expect(a.state).toBe('present');
    expect(a.attachments.map(p => p.kind)).toEqual(['document', 'document', 'inline', 'calendar']);
    expect(new Set(a.attachments.map(p => p.id)).size).toBe(4);
    expect(a).toEqual(inspectGmailAttachments(payload, 'reader@example.com', 'one'));
    expect(a.attachments[0].id).not.toBe(inspectGmailAttachments(payload, 'other@example.com', 'one').attachments[0].id);
    expect(a.attachments[0].id).not.toBe(inspectGmailAttachments(payload, 'reader@example.com', 'two').attachments[0].id);
    expect(a.attachments[0].attachmentId).toBeNull();
  });

  test('unclassifiable empty leaves and childless multipart containers remain incomplete', async () => {
    for (const payload of [{ mimeType: 'multipart/mixed' }, { mimeType: 'multipart/mixed', parts: [] }, { body: {} }, { mimeType: '', body: {} }]) {
      const result = await thread(payload);
      expect(result.messages[0].attachmentInspection).toEqual({ state: 'incomplete', reason: 'malformed_part', attachments: [] });
    }
    expect(inspectGmailAttachments({ mimeType: 'text/plain', body: {} }, 'reader@example.com', 'message')).toEqual({ state: 'none', attachments: [] });
    expect(inspectGmailAttachments({ mimeType: 'text/html', body: { size: 0 } }, 'reader@example.com', 'message')).toEqual({ state: 'none', attachments: [] });
    expect(inspectGmailAttachments({ filename: 'empty.pdf', mimeType: 'application/pdf', body: { size: 0 } }, 'reader@example.com', 'message')).toMatchObject({ state: 'present', attachments: [{ filename: 'empty.pdf', size: 0 }] });
  });

  test('deep, wide, malformed and oversized metadata has a bounded incomplete receipt', () => {
    let deep: GmailMimePart = { filename: 'hidden.pdf', mimeType: 'application/pdf' };
    for (let n = 0; n < 1000; n++) deep = { mimeType: 'multipart/mixed', parts: [deep] };
    expect(inspectGmailAttachments(deep, 'reader@example.com', 'one')).toMatchObject({ state: 'incomplete', reason: 'depth_limit' });
    const wide = { mimeType: 'multipart/mixed', parts: Array.from({ length: 10_000 }, () => ({ mimeType: 'text/plain' })) };
    expect(inspectGmailAttachments(wide, 'reader@example.com', 'one')).toMatchObject({ state: 'incomplete', reason: 'part_limit' });
    const malformed = { parts: [null, { filename: 1 }] } as unknown as GmailMimePart;
    expect(inspectGmailAttachments(malformed, 'reader@example.com', 'one').state).toBe('incomplete');
    for (const filename of ['null\0byte.pdf', 'unpaired\ud800.pdf']) {
      expect(inspectGmailAttachments({ filename, mimeType: 'application/pdf' }, 'reader@example.com', 'one')).toMatchObject({ state: 'incomplete', reason: 'malformed_part', attachments: [] });
    }
    const large = { filename: 'x'.repeat(GMAIL_MIME_LIMITS.receiptBytes + 1) };
    expect(inspectGmailAttachments(large, 'reader@example.com', 'one')).toMatchObject({ state: 'incomplete', reason: 'receipt_bytes_limit', attachments: [] });
    const aggregate = { parts: Array.from({ length: 100 }, () => ({ filename: 'é'.repeat(1000), mimeType: 'application/pdf' })) };
    const result = inspectGmailAttachments(aggregate, 'reader@example.com', 'one');
    expect(result.state).toBe('incomplete');
    expect(Buffer.byteLength(JSON.stringify(result.attachments))).toBeLessThan(GMAIL_MIME_LIMITS.receiptBytes);
  });

  test('untrusted filenames render as inert data and document text is not selected as the message body', async () => {
    const result = await thread({ parts: [
      { filename: '[x](javascript:alert(1))\n<script>bad</script>`', mimeType: 'text/plain', body: { data: 'U2VjcmV0IGRvY3VtZW50' } },
      { mimeType: 'text/plain', body: { data: 'SGVsbG8=' } },
    ] });
    expect(result.messages[0].bodyText).toBe('Hello');
    const text = renderAttachmentInspection(result.messages[0].attachmentInspection);
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('[x](');
    expect(text).not.toContain('\n<script>');
    expect(text).toContain('&#91;x&#93;');
  });

  test('missing message identity gets deterministic receipts but no fabricated Gmail citation', async () => {
    const client = new GmailClient(tokens, async () => Response.json({ id: 'abcdef', messages: [{ payload: { filename: 'file.pdf', mimeType: 'application/pdf' } }] }));
    const first = await client.getThread('abcdef', 'reader@example.com');
    expect(first).toEqual(await client.getThread('abcdef', 'reader@example.com'));
    expect(first.messages[0].attachmentInspection?.attachments[0].messageId).toBe('missing:abcdef:0');
    expect(renderThreadPage(first)!.markdown).toContain('Gmail message link unavailable.');
  });

  test('aggregate receipt bytes are bounded across messages in one thread', async () => {
    const client = new GmailClient(tokens, async () => Response.json({ id: 'abcdef', messages: Array.from({ length: 100 }, (_, n) => ({
      id: `message${String(n).padStart(10, '0')}`, payload: { filename: 'é'.repeat(2000), mimeType: 'application/pdf', body: { attachmentId: 'opaque', size: 42 } },
    })) }));
    const result = await client.getThread('abcdef', 'reader@example.com', { metadataOnly: true });
    expect(result.messages.some(m => m.attachmentInspection?.state === 'incomplete')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.messages.flatMap(m => m.attachmentInspection?.attachments ?? [])))).toBeLessThan(GMAIL_MIME_LIMITS.receiptBytes);
    expect(result.messages.every(m => m.bodyText === '')).toBe(true);
  });

  test('forwarded message document bodies are never selected as the main body', async () => {
    const result = await thread({ mimeType: 'multipart/mixed', parts: [
      { mimeType: 'message/rfc822', parts: [{ mimeType: 'text/plain', body: { data: 'U2VjcmV0IGRvY3VtZW50' } }] },
      { mimeType: 'text/plain', body: { data: 'SGVsbG8=' } },
    ] });
    expect(result.messages[0].bodyText).toBe('Hello');
    expect(result.messages[0].attachmentInspection?.attachments).toMatchObject([{ mimeType: 'message/rfc822', kind: 'document' }]);
  });
});

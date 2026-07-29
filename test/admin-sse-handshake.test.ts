import { describe, expect, test } from 'bun:test';
import { openAdminSseStream } from '../src/commands/serve-http.ts';

describe('admin SSE handshake', () => {
  test('flushes a protocol-valid comment immediately after the headers', () => {
    const calls: string[] = [];
    const headers = new Map<string, string>();

    openAdminSseStream({
      setHeader(name: string, value: string | number | readonly string[]) {
        headers.set(name, String(value));
        calls.push(`header:${name}`);
        return this;
      },
      flushHeaders() {
        calls.push('flush');
      },
      write(chunk: unknown) {
        calls.push(`write:${String(chunk)}`);
        return true;
      },
    });

    expect(headers).toEqual(new Map([
      ['Content-Type', 'text/event-stream'],
      ['Cache-Control', 'no-cache'],
      ['Connection', 'keep-alive'],
    ]));
    expect(calls).toEqual([
      'header:Content-Type',
      'header:Cache-Control',
      'header:Connection',
      'flush',
      'write:: connected\n\n',
    ]);
  });
});

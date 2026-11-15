/**
 * GST-2768 PR 1: Cookie and Set-Cookie header values in a pasted session
 * (curl -H / -b / --cookie arguments, raw HTTP headers, a devtools copy, a
 * copy-as-fetch JSON blob) reached the conversation page verbatim: no
 * detector reads a cookie value that is not a known token shape. The
 * transcript lane now claims each cookie value (cookie_header) and keeps the
 * cookie names, Set-Cookie attributes and ordinary prose about cookies.
 * Values are synthetic and built from parts (CEO-10).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { redactSession } from '../src/core/transcripts/render.ts';
import { TRANSCRIPT_SECRET_AUDIT_VERSION, auditTranscriptSecrets } from '../src/core/transcripts/secret-audit.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { COOKIE_PROSE_NEGATIVES } from './fixtures/transcripts/synthetic-credentials.ts';

const SID = ['SYNTH', 'cookieA0001fake'].join('');
const CSRF = ['SYNTH', 'cookieB0002fake'].join('');

function redact(texts: string[]): string[] {
  const session: ParsedSession = {
    meta: { harness: 'claude-code', sessionId: 'cookie-0001', startedAt: '2026-10-06T09:00:00.000Z' },
    messages: texts.map((text, i) => ({ role: 'user', timestamp: `2026-10-06T09:00:0${i}.000Z`, text })),
  };
  return redactSession(session, { patterns: [] }).session.messages.map((m) => m.text);
}
const one = (text: string): string => redact([text])[0]!;

describe('cookie_header: cookie values are redacted, names kept', () => {
  const cases: Array<[string, string, string]> = [
    ['curl -H Cookie with two pairs', `curl -H 'Cookie: sid=${SID}; csrf=${CSRF}' https://app.acme-example.test/`, `curl -H 'Cookie: sid=<REDACTED:cookie_header>; csrf=<REDACTED:cookie_header>' https://app.acme-example.test/`],
    ['curl -H "cookie:" lower case', `curl -H "cookie: sid=${SID}" https://app.acme-example.test/`, `curl -H "cookie: sid=<REDACTED:cookie_header>" https://app.acme-example.test/`],
    ['raw request header line', `Cookie: sid=${SID}; lang=en`, `Cookie: sid=<REDACTED:cookie_header>; lang=en`],
    ['Set-Cookie keeps its attributes', `Set-Cookie: sid=${SID}; Path=/; HttpOnly; Secure; Max-Age=3600`, `Set-Cookie: sid=<REDACTED:cookie_header>; Path=/; HttpOnly; Secure; Max-Age=3600`],
    ['quoted cookie value', `Set-Cookie: sid="${SID}"; Path=/`, `Set-Cookie: sid="<REDACTED:cookie_header>"; Path=/`],
    ['curl -b', `curl -b 'sid=${SID}; csrf=${CSRF}' https://app.acme-example.test/`, `curl -b 'sid=<REDACTED:cookie_header>; csrf=<REDACTED:cookie_header>' https://app.acme-example.test/`],
    ['curl --cookie=', `curl --cookie="sid=${SID}" https://app.acme-example.test/`, `curl --cookie="sid=<REDACTED:cookie_header>" https://app.acme-example.test/`],
    ['copy as fetch JSON', `{"headers": {"cookie": "sid=${SID}; csrf=${CSRF}"}}`, `{"headers": {"cookie": "sid=<REDACTED:cookie_header>; csrf=<REDACTED:cookie_header>"}}`],
    ['escaped JSON in a tool call', `{"command": "curl -H \"Cookie: sid=${SID}\" https://app.acme-example.test/"}`, `{"command": "curl -H \"Cookie: sid=<REDACTED:cookie_header>\" https://app.acme-example.test/"}`],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      const out = one(input);
      expect(out).toBe(expected);
      expect(out).not.toContain(SID);
      expect(out).not.toContain(CSRF);
    });
  }

  test('an apostrophe inside an earlier cookie does not stop parsing', () => {
    expect(one(`Cookie: theme=ab'cd; sid=${SID}`)).toBe("Cookie: theme=ab'cd; sid=<REDACTED:cookie_header>");
  });
  test('a percent-encoded value is redacted, not taken for a placeholder', () => {
    expect(one(`Cookie: sid=%2F${SID}`)).toBe('Cookie: sid=<REDACTED:cookie_header>');
  });
  test('a value holding a comma or a JSON-escaped slash is redacted whole', () => {
    expect(one(`Cookie: sid=${SID},${CSRF}`)).toBe('Cookie: sid=<REDACTED:cookie_header>');
    expect(one(`{"cookie": "sid=abc\\/${SID}"}`)).toBe('{"cookie": "sid=<REDACTED:cookie_header>"}');
  });
  test('curl -b far into a long command line is still a cookie', () => {
    const out = one(`curl -H "X-Trace: ${'t'.repeat(600)}" -b 'sid=${SID}' https://app.acme-example.test/`);
    expect(out).not.toContain(SID);
    expect(out).toContain("-b 'sid=<REDACTED:cookie_header>'");
  });
  test('a cookie value echoed in a later message is scrubbed too', () => {
    const out = redact([`Cookie: sid=${SID}`, `the session id is ${SID} right?`]);
    expect(out.join('\n')).not.toContain(SID);
  });

  test('a cookie value in a speaker label and raw metadata is redacted', () => {
    const session: ParsedSession = {
      meta: { harness: 'claude-code', sessionId: 'cookie-0002', raw: { request: `Cookie: sid=${SID}` } },
      messages: [{ role: 'user', speaker: `Cookie: sid=${SID}`, timestamp: '2026-10-06T09:00:00.000Z', text: 'hello' }],
    };
    const out = JSON.stringify(redactSession(session, { patterns: [] }).session);
    expect(out).not.toContain(SID);
    expect(out).toContain('<REDACTED:cookie_header>');
  });
});

describe('cookie_header: prose, placeholders and short preference values stay', () => {
  for (const text of COOKIE_PROSE_NEGATIVES) {
    test(JSON.stringify(text), () => expect(one(text)).toBe(text));
  }
  test('short preference values (theme=dark) are not claimed', () => {
    expect(one('Cookie: theme=dark; lang=en')).toBe('Cookie: theme=dark; lang=en');
  });
  test('a -b flag outside a curl command is not a cookie', () => {
    expect(one('git checkout -b feature=abcdefgh12345')).toBe('git checkout -b feature=abcdefgh12345');
  });
  test('curl -b with a cookie-jar file name is left alone', () => {
    expect(one('curl -b cookies.txt -c cookies.txt https://app.acme-example.test/')).toBe('curl -b cookies.txt -c cookies.txt https://app.acme-example.test/');
  });
});

describe('audit-secrets uses the transcript-lane rules', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });
  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('a stored page with a cookie header is affected; the audit version moved to 6', async () => {
    await engine.putPage('conversations/sessions/2026-01-02-codex-cccccccccccc', {
      type: 'conversation', title: 'session', compiled_truth: `intro\ncurl -H 'Cookie: sid=${SID}' https://app.acme-example.test/`,
      frontmatter: { transcript_import: { harness: 'codex', session_id: 'cookie' } },
    });
    const result = await auditTranscriptSecrets(engine);
    expect(result.by_pattern).toEqual({ cookie_header: 1 });
    expect(result.pages[0]!.lines).toEqual([2]);
    expect(JSON.stringify(result)).not.toContain(SID);
    expect(TRANSCRIPT_SECRET_AUDIT_VERSION).toBe(6);
  });
});

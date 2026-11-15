/**
 * GST-2768 PR 1: a credential label in one message ("here is my API key:",
 * "password:", "login: alice /") whose value arrives alone in the NEXT
 * message reached the conversation page verbatim, because each message was
 * scanned on its own. Same for a key or token label at the end of a line
 * with the value alone on the next line (only password and login labels
 * carried to the next line before). The transcript lane now joins them,
 * bounded to the first line of the next message. Values are synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { redactSession } from '../src/core/transcripts/render.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

const KEY = ['Synth3tic', 'ApiKeyValue0042'].join('');
const PW = ['Synth', '-pw-split-9'].join('');
const PAIR = ['Synth', '-pair-5!'].join('');
const TOKEN = ['Synth3tic', 'Tok3nValue0099'].join('');

function redact(texts: string[], roles: Array<'user' | 'assistant'> = []): string[] {
  const session: ParsedSession = {
    meta: { harness: 'claude-code', sessionId: 'cross-0001', startedAt: '2026-10-06T09:00:00.000Z' },
    messages: texts.map((text, i) => ({ role: roles[i] ?? 'user', timestamp: `2026-10-06T09:00:0${i}.000Z`, text })),
  };
  return redactSession(session, { patterns: [] }).session.messages.map((m) => m.text);
}

describe('a label in one message, its value in the next', () => {
  test('API key label, then the key alone', () => {
    expect(redact(['here is my API key:', KEY])).toEqual(['here is my API key:', '<REDACTED:labeled_credential>']);
  });
  test('password label, then the password alone', () => {
    expect(redact(['password:', PW])).toEqual(['password:', '<REDACTED:labeled_credential>']);
  });
  test('login pair with the password in the next message', () => {
    expect(redact(['login: alice-example /', PAIR])).toEqual(['login: alice-example /', '<REDACTED:labeled_credential>']);
  });
  test('an assistant prompt, then the user pastes the token', () => {
    expect(redact(['Paste your access token:', TOKEN], ['assistant', 'user'])[1]).toBe('<REDACTED:labeled_credential>');
  });
  test('only the first line of the next message is read', () => {
    const out = redact(['password:', `${PW}\nand the rest of the note`]);
    expect(out[1]).toBe('<REDACTED:labeled_credential>\nand the rest of the note');
  });
  test('the joined value is scrubbed where it is echoed later', () => {
    const out = redact(['here is my API key:', KEY, `I set it to ${KEY} in the config`]);
    expect(out.join('\n')).not.toContain(KEY);
  });
});

describe('a key or token label at the end of a line, the value on the next', () => {
  test('access token label', () => {
    expect(redact([`ok, the access token:\n${TOKEN}`])[0]).toBe('ok, the access token:\n<REDACTED:labeled_credential>');
  });
  test('API key label in an env-style note', () => {
    expect(redact([`OpenAI api key:\n  ${KEY}`])[0]).toBe('OpenAI api key:\n  <REDACTED:labeled_credential>');
  });
});

describe('bounded lookahead and prose stay intact', () => {
  test('a value two messages later is not joined', () => {
    expect(redact(['password:', 'one sec', PW])).toEqual(['password:', 'one sec', PW]);
  });
  test('prose after a key label is not claimed', () => {
    expect(redact(['here is my API key:', 'hold on, looking for it'])).toEqual(['here is my API key:', 'hold on, looking for it']);
    expect(redact(['Next token:', 'Thanks'])).toEqual(['Next token:', 'Thanks']);
    expect(redact([`the secret:\nnothing to see`])).toEqual([`the secret:\nnothing to see`]);
  });
  test('a short or letter-only word after a key label is not claimed', () => {
    expect(redact(['api key:', 'missing'])).toEqual(['api key:', 'missing']);
    expect(redact(['token:', 'abc123'])).toEqual(['token:', 'abc123']);
  });
  test('a code identifier after a key label is not claimed', () => {
    expect(redact(['the token:', 'process.env.API_TOKEN_V2'])).toEqual(['the token:', 'process.env.API_TOKEN_V2']);
  });
});

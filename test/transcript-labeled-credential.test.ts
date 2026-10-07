/**
 * The transcript lane's `labeled_credential` detector (#6147 idea, widened).
 * A low-entropy password typed into a conversation (`password: hunter2`,
 * `login alice / hunter2`) cleared both the vendor shapes and the
 * entropy-gated assignment heuristic, so it reached the searchable
 * conversation page verbatim.
 *
 * MUST_REDACT holds every leak form from the investigation lane's bypass
 * probe; MUST_KEEP holds its over-redaction cases plus code and prose a
 * coding transcript is full of. Credential values are synthetic.
 */
import { describe, expect, test } from 'bun:test';
import { buildSyntheticBrainCorpus } from '../scripts/secret-scan-fp-budget.ts';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';
import { LABELED_STOPLIST, labeledEchoEligible } from '../src/core/secret-scan-labeled.ts';
import { redactSession, renderSessionParts } from '../src/core/transcripts/render.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

const PW = ['hunter', '2'].join('');
const LONG_PW = ['Tr0ub4', 'dor&3x'].join('');

function session(texts: string[], meta: Partial<ParsedSession['meta']> = {}): ParsedSession {
  return {
    meta: { harness: 'claude-code', sessionId: 'labeled-cred-0001', startedAt: '2026-10-06T09:00:00.000Z', ...meta },
    messages: texts.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', timestamp: `2026-10-06T09:00:0${i}.000Z`, text })),
  };
}

function pageText(texts: string[]): string {
  return redactSession(session(texts), { userPatternsPath: '/nonexistent' }).session.messages.map((m) => m.text).join('\n');
}

const MUST_REDACT: Array<[string, string]> = [
  ['bare password label', `password: ${PW}`],
  ['username then password on one line', `username: alice-example password: ${PW}`],
  ['delimiter-free login pair', `login alice-example / ${PW}`],
  ['dash-delimited login pair', `Login - alice-example / ${PW}`],
  ['single-quoted pair', `login: 'alice-example' / '${PW}'`],
  ['backticked pair', `login: \`alice-example\` / \`${PW}\``],
  ['full-width colon', `login：alice-example / ${PW}`],
  ['creds label', `creds: alice-example / ${PW}`],
  ['user/pass label', `user/pass: alice-example / ${PW}`],
  ['colon-joined pair', `login: alice-example:${PW}`],
  ['equals and slash without spaces', `login=alice-example/${PW}`],
  ['pair split across a newline', `login: alice-example /\n${PW}`],
  ['credentials pair', `credentials: alice-example / ${PW}`],
  ['plain login pair', `login: alice-example / ${PW}`],
  ['markdown bold label', `**Password:** ${PW}`],
  ['JSON key', `{"password": "${PW}"}`],
  ['prefixed env name', `DB_PASSWORD=${PW}`],
  ['full-width colon after password', `password：${PW}`],
  ['pwd label', `pwd=${PW}`],
  ['passcode label', `passcode: ${PW}`],
  ['trailing sentence punctuation', `The password: ${PW}.`],
];

const MUST_KEEP: Array<[string, string]> = [
  ['login flow prose', 'Login: email/password flow is broken'],
  ['SSO provider pair', 'login: Google/GitHub SSO'],
  ['doc path', 'credentials: docs/auth.md'],
  ['host and path', 'login: example.test/path'],
  ['n/a', 'login: n/a'],
  ['type annotation', 'password: string'],
  ['validator chain', 'password: z.string().min(8)'],
  ['request field', 'password = req.body.password'],
  ['shell pwd output', 'pwd: /home/alice-example'],
  ['PWD env', 'PWD=/home/alice-example'],
  ['mask', 'password: ********'],
  ['prose after the label', 'Password: changed yesterday'],
  ['yes', 'password: yes'],
  ['login page path', 'login page / step2'],
  ['env reference', 'password=$DB_PASS'],
  ['template reference', 'password: ${DB_PASSWORD}'],
  ['identifier declaration', 'const hashedPassword: string'],
  ['identifier value', 'password: hashedPassword'],
  ['delimiter-free prose', 'password reset flow'],
  ['URL after login', 'login: https://example.test/v2'],
  ['placeholder', 'password: <your password>'],
  ['function call', 'pwd = os.getcwd()'],
  ['versions', 'login: v1.2/v1.3'],
  ['type name', 'password: SecretStr = Field()'],
  ['await', 'const passphrase = await passphraseFrom(args);'],
  ['code span label', 'the libpq form (`password=`, `sslpassword=`) is scrubbed'],
  ['already redacted', 'password: <REDACTED:high_entropy_assignment>'],
];

describe('labeled_credential on the transcript page lane', () => {
  for (const [name, text] of MUST_REDACT) {
    test(`redacts: ${name}`, () => {
      const out = pageText([text]);
      expect(out).not.toContain(PW);
      expect(out).toContain('<REDACTED:labeled_credential>');
    });
  }
  for (const [name, text] of MUST_KEEP) {
    test(`keeps: ${name}`, () => {
      expect(pageText([text])).toBe(text);
    });
  }

  test('only the password half of a pair is claimed; the user name stays readable', () => {
    expect(pageText([`login: alice-example / ${PW}`])).toBe('login: alice-example / <REDACTED:labeled_credential>');
  });

  test('the receipt counts a typed labeled_credential finding', () => {
    const red = redactSession(session([`password: ${PW}`]), { userPatternsPath: '/nonexistent' });
    expect(red.redactionCount).toBe(1);
    expect(scanText(`password: ${PW}`, { labeledCredentials: true }).map((f) => f.pattern)).toEqual(['labeled_credential']);
  });

  test('a value of 8+ characters joins the session-wide echo list: a bare repeat in another message and the title is scrubbed', () => {
    const red = redactSession(
      session([`creds for staging: login alice-example / ${LONG_PW}`, `retrying with ${LONG_PW} now`], { title: `staging ${LONG_PW}` }),
      { userPatternsPath: '/nonexistent' },
    );
    expect(JSON.stringify(red.session)).not.toContain(LONG_PW);
    expect(red.session.messages[1].text).toBe('retrying with <REDACTED:labeled_credential> now');
    const content = renderSessionParts(red).parts[0].content;
    expect(content).not.toContain(LONG_PW);
  });

  test('echo floor: a short or common value is redacted at its label but never scrubbed elsewhere', () => {
    const out = pageText(['pwd: 1234', 'the room is 1234 and the code reviewer said 1234']);
    expect(out).toBe('pwd: <REDACTED:labeled_credential>\nthe room is 1234 and the code reviewer said 1234');
    expect(labeledEchoEligible('1234')).toBe(false);
    expect(labeledEchoEligible('passwords')).toBe(true);
    expect(labeledEchoEligible('required')).toBe(false);
    expect(LABELED_STOPLIST.has('required')).toBe(true);
  });
});

describe('labeled_credential is opt-in', () => {
  test('off by default, and off with only highEntropy (the push gate and every other lane)', () => {
    expect(scanText(`password: ${PW}`)).toEqual([]);
    expect(scanText(`password: ${PW}`, { highEntropy: true })).toEqual([]);
    expect(redactFindings(`login alice-example / ${PW}`, { highEntropy: true }).text).toBe(`login alice-example / ${PW}`);
  });

  test('the synthetic brain-like clean corpus gains no labeled_credential finding', () => {
    for (const doc of buildSyntheticBrainCorpus().filter((d) => d.kind === 'clean')) {
      expect(scanText(doc.text, { highEntropy: true, labeledCredentials: true }).filter((f) => f.pattern === 'labeled_credential')).toEqual([]);
    }
  });
});

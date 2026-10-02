/**
 * secret-scan credential shapes added or widened by the security fix wave:
 * A2 `url_credentials` (http/https userinfo with a password, ENG-14
 * placeholders, CEO-12b miss), A3 `basic_auth` (decode-to-`user:pass`
 * validate, ENG-15 bounds), A4 `digitalocean` (DX-5 name, hard right edge),
 * A5 punctuated assignment values (two compiled variants, ENG-13 rejections,
 * regex-expressed trailing trim, idempotence), CEO-12 ordering and the DX-5
 * `since` field, CRLF across every new line pattern (ENG-17).
 *
 * Every credential-shaped value is random and assembled at runtime from
 * parts (CEO-10): no literal secret, no literal URL with userinfo.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'crypto';
import { patternSince, redactFindings, scanText } from '../src/core/secret-scan.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Random alphanumeric string that always carries a digit (entropy rule input). */
function rand(n: number): string {
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[bytes[i]! % ALNUM.length];
  return s.slice(0, n - 1) + String(bytes[0]! % 10);
}
const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
const PLACEHOLDER_NONCE = 'GSTACK_EXAMPLE_NONCE';
const SCHEME_SEP = ':' + '//';
/** `scheme://user:password@host/path`, assembled from parts. */
const userinfoUrl = (scheme: string, user: string, password: string, rest = 'host.example/path') =>
  [scheme, SCHEME_SEP, user, ':', password, '@', rest].join('');
const basic = (userPass: string) => Buffer.from(userPass).toString('base64');
const REDACTED = (p: string) => `<REDACTED:${p}>`;

describe('A2 url_credentials: http(s) userinfo carrying a password', () => {
  test('fires on http and https in any case; the value is the userinfo span, host and path kept', () => {
    const pw = rand(24);
    for (const scheme of ['https', 'http', 'HTTPS', 'Http']) {
      const url = userinfoUrl(scheme, 'x-access-token', pw);
      const findings = scanText(`git clone ${url}.git`);
      expect(findings.map((f) => f.pattern)).toEqual(['url_credentials']);
      expect(JSON.stringify(findings).includes(pw)).toBe(false);
      expect(redactFindings(`git clone ${url}.git`).text).toBe(`git clone ${REDACTED('url_credentials')}host.example/path.git`);
    }
  });

  test('the design reversal: a short user:pw pair on an https URL now fires', () => {
    expect(scanText(userinfoUrl('https', 'user', 'pw')).map((f) => f.pattern)).toEqual(['url_credentials']);
  });

  test('a password made of the approved placeholder nonce still fires (it is not a placeholder SHAPE)', () => {
    expect(scanText(userinfoUrl('https', 'alice-example', PLACEHOLDER_NONCE)).map((f) => f.pattern)).toEqual(['url_credentials']);
  });

  test('URLs without a password, or with an @ in the path, stay untouched', () => {
    const at = '@';
    for (const s of [
      ['https', SCHEME_SEP, 'user', at, 'host'].join(''),
      ['https', SCHEME_SEP, 'host/a', at, 'b'].join(''),
      ['http', SCHEME_SEP, 'localhost:5173/', at, 'vite/client'].join(''),
      ['https', SCHEME_SEP, 'registry.example/', at, 'scope/pkg'].join(''),
      ['https', SCHEME_SEP, 'host:443/', at, 'user'].join(''),
    ]) {
      expect(scanText(s)).toEqual([]);
      expect(redactFindings(s, { highEntropy: true }).text).toBe(s);
    }
  });

  test('ENG-14: placeholder-shaped passwords do not fire', () => {
    for (const pw of ['<password>', '<PASSWORD>', '${DB_PASSWORD}', '$PASSWORD', '****', 'xxxxxxxx', 'XXXX']) {
      expect(scanText(userinfoUrl('https', 'user', pw))).toEqual([]);
    }
  });

  test('CEO-12b: a password carrying a literal `/`, `?` or `#` is the accepted miss', () => {
    for (const sep of ['/', '?', '#']) {
      expect(scanText(userinfoUrl('https', 'user', `${rand(8)}${sep}${rand(8)}`))).toEqual([]);
    }
  });

  test('bounds: user 0-128, password 1-256', () => {
    expect(scanText(userinfoUrl('https', '', rand(16))).map((f) => f.pattern)).toEqual(['url_credentials']);
    expect(scanText(userinfoUrl('https', 'u', rand(256))).map((f) => f.pattern)).toEqual(['url_credentials']);
    expect(scanText(userinfoUrl('https', 'u', rand(257)))).toEqual([]);
    expect(scanText(userinfoUrl('https', 'u'.repeat(129), rand(12)))).toEqual([]);
  });

  test('a vendor token used as the password keeps its vendor attribution; the userinfo around it is still covered', () => {
    const ghp = ['ghp', rand(36)].join('_');
    const { text, redactions } = redactFindings(userinfoUrl('https', 'x-access-token', ghp, 'github.com/org/repo'));
    expect(text.includes(ghp)).toBe(false);
    expect(text.includes('x-access-token')).toBe(false);
    expect(redactions.map((r) => r.pattern)).toContain('github_token');
    expect(text.endsWith('github.com/org/repo')).toBe(true);
  });
});

describe('A3 basic_auth: a Basic credential that decodes to user:pass', () => {
  test('header form, any case, including the short u:p encoding', () => {
    const short = basic('u:p');
    expect(short.length).toBe(4);
    const long = basic(`alice-example:${rand(20)}`);
    for (const line of [
      `Authorization: Basic ${short}`,
      `authorization: basic ${short}`,
      `AUTHORIZATION:BASIC ${long}`,
      `Proxy-Authorization: Basic ${long}`,
      `curl -H "Authorization: Basic ${long}" https://api.example`,
    ]) {
      const { text, redactions } = redactFindings(line);
      expect(redactions.map((r) => r.pattern)).toEqual(['basic_auth']);
      expect(text.includes(short) || text.includes(long)).toBe(false);
    }
    expect(redactFindings(`Authorization: Basic ${short}`).text).toBe(`Authorization: Basic ${REDACTED('basic_auth')}`);
  });

  test('bare form needs 16+ chars', () => {
    const v = basic(`svc:${rand(14)}`);
    expect(v.length).toBeGreaterThanOrEqual(16);
    expect(scanText(`use Basic ${v} for the proxy`).map((f) => f.pattern)).toEqual(['basic_auth']);
    expect(scanText(`use Basic ${basic('u:p')} for the proxy`)).toEqual([]);
  });

  test('prose after the word Basic stays untouched', () => {
    for (const s of [
      'Basic responsibilities include on-call',
      'basic internationalization support',
      'Authorization: Basic auth is deprecated',
      'see Basic concepts in the docs',
      'Basic AAAAAAAAAAAAAAAAAAAAAAAA', // decodes to NUL bytes
    ]) {
      expect(scanText(s)).toEqual([]);
      expect(redactFindings(s, { highEntropy: true }).text).toBe(s);
    }
  });

  test('ENG-15: the value is bounded 4-2048 with a hard right edge; a longer run is not claimed', () => {
    const at2048 = basic(`u:${'a'.repeat(1534)}`);
    expect(at2048.length).toBe(2048);
    expect(scanText(`Authorization: Basic ${at2048}`).map((f) => f.pattern)).toEqual(['basic_auth']);
    const over = basic(`u:${'a'.repeat(1540)}`);
    expect(over.length).toBeGreaterThan(2048);
    expect(scanText(`Authorization: Basic ${over}`)).toEqual([]);
  });

  test('basic_auth is not in the bearer echo family: a bare echo of the value is not scrubbed', () => {
    const v = basic(`alice-example:${rand(20)}`);
    const { text, echoValues } = redactFindings(`Authorization: Basic ${v}\nlater: ${v}`);
    expect(echoValues.size).toBe(0);
    expect(text.split('\n')[1]).toBe(`later: ${v}`);
  });
});

describe('A4 digitalocean', () => {
  test('dop_/doo_/dor_ v1 tokens fire as digitalocean', () => {
    for (const p of ['dop', 'doo', 'dor']) {
      const tok = [p, 'v1', hex(64)].join('_');
      const findings = scanText(`DO token ${tok} end`);
      expect(findings.map((f) => f.pattern)).toEqual(['digitalocean']);
      expect(redactFindings(`t ${tok}`).text).toBe(`t ${REDACTED('digitalocean')}`);
    }
  });

  test('hard right edge and exact hex body: 65 hex, 63 hex, uppercase hex and an embedded prefix do not fire', () => {
    for (const s of [
      ['dop', 'v1', hex(64) + 'a'].join('_'),
      ['dop', 'v1', hex(63)].join('_'),
      ['dop', 'v1', hex(64).toUpperCase().replace(/[0-9]/g, 'A')].join('_'),
      'x' + ['dop', 'v1', hex(64)].join('_'),
    ]) {
      expect(scanText(s)).toEqual([]);
    }
  });
});

describe('A5 high_entropy_assignment: punctuated values', () => {
  const he = (s: string) => redactFindings(s, { highEntropy: true });
  const T = REDACTED('high_entropy_assignment');

  test('unquoted values with password punctuation are claimed whole', () => {
    for (const v of [`!${rand(14)}`, `${rand(10)}!#%${rand(10)}`, `${rand(8)}$*@^~${rand(8)}`, `${rand(8)}.?<>${rand(8)}`]) {
      expect(he(`password=${v}`).text).toBe(`password=${T}`);
      expect(he(`DB_PASSWORD: ${v}`).text).toBe(`DB_PASSWORD: ${T}`);
    }
  });

  test('quoted values are any run of non-quote, non-whitespace characters', () => {
    const v = `${rand(10)}!#%&()<${rand(10)}`;
    expect(he(`DB_PASSWORD="${v}"`).text).toBe(`DB_PASSWORD="${T}"`);
    expect(he(`{"api_key": '${v}'}`).text).toBe(`{"api_key": '${T}'}`);
  });

  test('`&`, `,`, `;` and brackets end an unquoted value: query parameters, SQL SET lists and code calls survive', () => {
    const tok = rand(24);
    expect(he(`?token=${tok}&page=2`).text).toBe(`?token=${T}&page=2`);
    expect(he('token = getToken(x1, y2, zz3)').text).toBe('token = getToken(x1, y2, zz3)');
    expect(he('password = process.env.DB_PASSWORD_2').text).toBe('password = process.env.DB_PASSWORD_2');
    const sql = 'SET execution_token=NULL,claim_expires_at=NULL,error_code=$3,updated_at=now()';
    expect(he(sql).text).toBe(sql);
    expect(he(`cookie: session_token=${tok}; path=/`).text).toBe(`cookie: session_token=${T}; path=/`);
  });

  test('trailing sentence punctuation is not part of an unquoted value, and the bare echo still scrubs', () => {
    const tok = rand(24);
    for (const tail of ['.', ',', ';', '?', '!', '...', '.)']) {
      expect(he(`TOKEN=${tok}${tail}`).text).toBe(`TOKEN=${T}${tail}`);
    }
    expect(he(`set TOKEN=${tok}. Then later the agent printed ${tok} again`).text)
      .toBe(`set TOKEN=${T}. Then later the agent printed ${T} again`);
  });

  test('a vendor token at the start of a punctuated value keeps its attribution; the tail is still covered', () => {
    const ghp = ['ghp', rand(36)].join('_');
    const tail = `!tail-${rand(16)}`;
    const { text } = he(`password=${ghp}${tail}`);
    expect(text.includes(ghp)).toBe(false);
    expect(text.includes(tail)).toBe(false);
  });

  test('ENG-13: URLs, paths and shell expansions are not secrets', () => {
    for (const s of [
      `token_url: "https://oauth2.example.com/token?v=${rand(6)}"`,
      `credentials_path: "/home/alice-example/.config/app${rand(4)}/creds.json"`,
      `credentials_path: /home/alice-example/.config/app${rand(4)}/creds.json`,
      `secret_file = ./secrets/prod${rand(6)}.env.json`,
      `api_key_file: ~/keys/${rand(10)}.txt`,
      `password: "\${{ secrets.DB_PASSWORD_${rand(6)} }}"`,
      `TOKEN=$(cat /run/secrets/token${rand(6)})`,
    ]) {
      expect(he(s).text).toBe(s);
    }
  });

  test('a pure base64 value that starts with `/` still fires (one random secret in 64 does)', () => {
    const v = `/${rand(20)}+${rand(10)}/${rand(8)}`;
    expect(he(`aws_secret_access_key = ${v}`).text).toBe(`aws_secret_access_key = ${T}`);
  });

  test('idempotence: redacting redacted output changes nothing', () => {
    const v = `${rand(10)}!#%<${rand(10)}`;
    const once = he(`password="${v}" and TOKEN=${rand(20)}. done`).text;
    expect(once).toBe(`password="${T}" and TOKEN=${T}. done`);
    expect(he(once).text).toBe(once);
    expect(he(once).redactions).toEqual([]);
  });

  test('prose and placeholder assignments stay byte-identical', () => {
    for (const s of [
      'export GITHUB_TOKEN=',
      'password: ****',
      'api_key = TODO',
      'the token is stored in the keychain, not in the repo',
      `password=${PLACEHOLDER_NONCE}`,
      'password=<your-password-here>',
    ]) {
      expect(he(s).text).toBe(s);
    }
  });
});

describe('CEO-12 ordering and DX-5 since', () => {
  test('vendor shapes win attribution over the appended catch-alls', () => {
    const tok = ['dop', 'v1', hex(64)].join('_');
    expect(scanText(`Authorization: Bearer ${tok}`).map((f) => f.pattern)).toEqual(['digitalocean']);
  });

  test('every new or changed rule carries since; unchanged rules do not', () => {
    const since = patternSince('url_credentials');
    expect(since).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    for (const p of ['basic_auth', 'digitalocean', 'private_key_pem']) expect(patternSince(p)).toBe(since);
    for (const p of ['openai', 'bearer', 'db_url_credentials', 'high_entropy_assignment']) expect(patternSince(p)).toBeUndefined();
    const [f] = scanText(`t ${['dop', 'v1', hex(64)].join('_')}`);
    expect(f!.since).toBe(since);
    const [g] = scanText(`k ${['ghp', rand(36)].join('_')}`);
    expect(g!.since).toBeUndefined();
  });
});

describe('ENG-17: CRLF line ends behave like LF for every new line pattern', () => {
  test('the same findings and the same redacted bytes before the line end', () => {
    const lines = [
      `clone ${userinfoUrl('https', 'u', rand(20))}`,
      `Authorization: Basic ${basic(`alice-example:${rand(12)}`)}`,
      `do ${['dop', 'v1', hex(64)].join('_')}`,
      `password=${rand(10)}!#%${rand(6)}`,
      `token="${rand(10)}<${rand(6)}"`,
      `TOKEN=${rand(20)}.`,
    ];
    const lf = redactFindings(lines.join('\n') + '\n', { highEntropy: true });
    const crlf = redactFindings(lines.join('\r\n') + '\r\n', { highEntropy: true });
    expect(crlf.redactions.map((r) => r.pattern)).toEqual(lf.redactions.map((r) => r.pattern));
    expect(crlf.redactions.length).toBe(lines.length);
    expect(crlf.text).toBe(lf.text.replace(/\n/g, '\r\n'));
  });
});

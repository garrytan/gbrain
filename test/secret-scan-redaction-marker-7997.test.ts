/**
 * #7997: the transcript importer replaces what it removes with `<REDACTED:kind>` (a user pattern becomes
 * `<REDACTED:user-pattern>`). The labeled_credential pair pattern split that marker at its colon and claimed
 * `login **<REDACTED:user-pattern>**` as a user/password pair, so a correctly redacted page never cleared
 * `gbrain transcripts audit-secrets`, and the pair match swallowed a real password written after the marker. Now:
 * - a marker after a credential label is never a credential, in any label form;
 * - a credential written beside a marker is still claimed, and the marker is left as written;
 * - re-redacting a redacted transcript changes nothing, and the audit reports zero pages for it (PGLite).
 * Credential values are synthetic. Contributed by @Masashi-Ono0611 (#7999, superseded).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';
import { redactSession } from '../src/core/transcripts/render.ts';
import { auditTranscriptSecrets } from '../src/core/transcripts/secret-audit.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const PW = ['Tr0ub4', 'dor&3x'].join('');
const LANE = { highEntropy: true, labeledCredentials: true };

const MARKERS: Array<[string, string]> = [
  ['a user-pattern marker after a bold login label (the reported page line)', 'login **<REDACTED:user-pattern>**'],
  ['a marker after a delimited login label', 'login: <REDACTED:labeled_credential>'],
  ['a marker after a credentials label', 'credentials <REDACTED:user-pattern>'],
  ['a bold marker after creds:', 'creds: **<REDACTED:secret>**'],
  ['a marker after a password label', 'password: <REDACTED:labeled_credential>'],
  ['a marker pair joined by a colon', 'login <REDACTED:user-pattern>:<REDACTED:user-pattern>'],
  ['a marker pair joined by a slash', 'login <REDACTED:user-pattern> / <REDACTED:labeled_credential>'],
  ['a marker ending a sentence', 'login: <REDACTED:labeled_credential>.'],
];

const BESIDE: Array<[string, string]> = [
  ['a password after a slash beside a bold marker user', `login **<REDACTED:user-pattern>** / ${PW}`],
  ['a password after a slash beside a marker user', `login <REDACTED:user-pattern> / ${PW}`],
  ['a password right after a marker user and colon', `login <REDACTED:user-pattern>:${PW}`],
  ['a password label after a marker on the same line', `<REDACTED:user-pattern> password: ${PW}`],
  ['a login pair before a marker on the same line', `login alice-example / ${PW} <REDACTED:secret>`],
];

/** A marker glued to more text is no single word: as before the fix, that text is claimed (taking part of the marker with it). */
const GLUED: Array<[string, string]> = [
  ['a password glued onto a marker user', `login <REDACTED:user-pattern>${PW}`],
  ['a password glued onto a bold marker', `login: **<REDACTED:secret>**${PW}`],
  ['a password glued onto a marker after a user name', `creds alice<REDACTED:x>${PW}`],
];

describe('#7997: importer redaction markers and labeled_credential', () => {
  for (const [name, line] of MARKERS) test(`${name} is no credential`, () => {
    expect(scanText(line, LANE)).toEqual([]);
    expect(redactFindings(line, LANE).text).toBe(line);
  });

  for (const [name, line] of BESIDE) test(`${name} is still claimed; the marker stays as written`, () => {
    expect(scanText(line, LANE).map(f => f.pattern)).toEqual(['labeled_credential']);
    const out = redactFindings(line, LANE).text;
    expect(out).not.toContain(PW);
    for (const marker of line.match(/<REDACTED:[a-z_-]+>/g) ?? []) expect(out).toContain(marker);
  });

  for (const [name, line] of GLUED) test(`${name} is still claimed`, () => {
    expect(scanText(line, LANE).map(f => f.pattern)).toEqual(['labeled_credential']);
    expect(redactFindings(line, LANE).text).not.toContain(PW);
  });

  test('re-redacting an imported transcript that already holds markers changes nothing', () => {
    const session = (text: string): ParsedSession => ({ meta: { harness: 'codex', sessionId: 'marker-0001', startedAt: '2026-10-30T09:00:00.000Z' },
      messages: [{ role: 'user', timestamp: '2026-10-30T09:00:00.000Z', text }] });
    const patterns = [{ regex: /alice-example \/ [^\s*]+/g, source: 'alice-example' }];
    const first = redactSession(session(`login **alice-example / ${PW}**`), { patterns }).session.messages[0]!.text;
    expect(first).not.toContain(PW);
    expect(first).toContain('<REDACTED:');
    const again = redactSession(session(first), { patterns });
    expect(again.redactionCount).toBe(0);
    expect(again.session.messages[0]!.text).toBe(first);
  });
});

describe('#7997: audit-secrets on a redacted corpus', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });
  const conversation = (slug: string, body: string) => engine.putPage(slug, { type: 'conversation', title: 'session', compiled_truth: body,
    frontmatter: { transcript_import: { harness: 'codex', session_id: slug } } });

  test('a page holding only markers is not affected; a real password beside a marker still is', async () => {
    await conversation('conversations/sessions/2026-10-30-codex-aaaaaaaaaaaa', MARKERS.map(([, line]) => line).join('\n'));
    expect(await auditTranscriptSecrets(engine)).toMatchObject({ pages_scanned: 1, pages_affected: 0, hits_total: 0 });
    await conversation('conversations/sessions/2026-10-30-codex-bbbbbbbbbbbb', `intro\n${BESIDE[0]![1]}`);
    expect(await auditTranscriptSecrets(engine)).toMatchObject({ pages_scanned: 2, pages_affected: 1, hits_total: 1, by_pattern: { labeled_credential: 1 } });
  });
});

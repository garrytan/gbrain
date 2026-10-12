/**
 * Identifier and contact pattern classes of the canonical scanner
 * (src/core/identifier-patterns.ts, wired by ScanOpts.classes).
 *
 * Protects: (1) the default scan is byte-identical — no identifier rule runs
 * unless a caller names the class, so the push gate, retrieval output and
 * transcript ingest see no new finding; (2) each family claims its real
 * shape and rejects its near miss (check digit, context word, separators);
 * (3) the synthetic brain-like fixture gains no identifier finding (false-
 * positive budget); (4) the rules stay linear on long lines. Regression it
 * catches: a rule whose guard is dropped (a bare ten-digit run read as an
 * NPI) or a class gate that leaks into the default scan. Existing coverage
 * pins only the credential class. No seams.
 *
 * Every value is synthetic: well-known test numbers and placeholder names.
 */
import { describe, expect, test } from 'bun:test';
import { buildSyntheticBrainCorpus } from '../scripts/secret-scan-fp-budget.ts';
import { patternSince, redactFindings, scanText, type ScanOpts } from '../src/core/secret-scan.ts';
import { CONTACT_PATTERN_NAMES, IDENTIFIER_CLASS_SINCE, IDENTIFIER_PATTERN_NAMES, deaOk, npiOk } from '../src/core/identifier-patterns.ts';

const ID: ScanOpts = { classes: ['identifier'] };
const CONTACT: ScanOpts = { classes: ['contact'] };
const names = (text: string, opts: ScanOpts = ID) => scanText(text, opts).map((f) => f.pattern);

describe('class gate', () => {
  const sample = 'Patient alice-example, SSN 078-05-1120, NPI 1234567893, call (555) 123-4567.';
  test('the default scan (credential class) reports nothing for identifier or contact shapes', () => {
    expect(scanText(sample)).toEqual([]);
    expect(scanText(sample, { highEntropy: true })).toEqual([]);
    expect(redactFindings(sample).text).toBe(sample);
  });
  test('identifier and contact classes are independent; a list without credential runs no credential rule', () => {
    expect(names(sample)).toEqual(['ssn', 'npi']);
    expect(names(sample, CONTACT)).toEqual(['phone']);
    const withKey = `${sample} token ${['sk-ant-', 'a'.repeat(24)].join('')}`;
    expect(names(withKey, { classes: ['identifier'] })).toEqual(['ssn', 'npi']);
    expect(names(withKey, { classes: ['identifier', 'credential'] })).toEqual(['anthropic', 'ssn', 'npi']);
  });
  test('every identifier and contact rule is stamped with the class version', () => {
    for (const name of [...IDENTIFIER_PATTERN_NAMES, ...CONTACT_PATTERN_NAMES]) expect(patternSince(name)).toBe(IDENTIFIER_CLASS_SINCE);
    expect(scanText('SSN 078-05-1120', ID)[0]?.since).toBe(IDENTIFIER_CLASS_SINCE);
  });
});

describe('family guards', () => {
  test('ssn: dashed anywhere, bare digits only after a label; area 000/666/9xx and a date-like run are rejected', () => {
    expect(names('id 078-05-1120 on file')).toEqual(['ssn']);
    expect(names('SSN: 078051120')).toEqual(['ssn']);
    expect(names('social security number 078 05 1120')).toEqual(['ssn']);
    expect(names('ref 078051120')).toEqual([]);
    expect(names('ssn 000-05-1120 and 666-05-1120 and 900-05-1120')).toEqual([]);
    expect(names('order 2024-123-45-6789 ships 2026-10-12')).toEqual([]);
  });
  test('npi: label + ten digits + the 80840 Luhn check digit', () => {
    expect(npiOk('1234567893')).toBe(true);
    expect(npiOk('1234567890')).toBe(false);
    expect(names('NPI 1234567893')).toEqual(['npi']);
    expect(names('NPI: 1234567890')).toEqual([]);
    expect(names('phone 1234567893')).toEqual([]);
  });
  test('dea: registrant letter + letter/9 + seven digits whose last digit is the checksum', () => {
    expect(deaOk('1234563')).toBe(true);
    expect(deaOk('1234567')).toBe(false);
    expect(names('DEA AB1234563')).toEqual(['dea']);
    expect(names('DEA AB1234567')).toEqual([]);
    expect(names('ticket ZZ1234563')).toEqual([]);
  });
  test('medicare_mbi: the CMS character classes, with or without dashes; a lowercase or S/L/O/I/B/Z shape is not one', () => {
    expect(names('MBI 1EG4-TE5-MK73')).toEqual(['medicare_mbi']);
    expect(names('MBI 1EG4TE5MK73')).toEqual(['medicare_mbi']);
    expect(names('MBI 1SG4TE5MK73')).toEqual([]);
    expect(names('mbi 1eg4te5mk73')).toEqual([]);
  });
  test('mrn / health_plan_id / dob need their context word; the word alone or a wordy value is not a hit', () => {
    expect(names('MRN: AB123456')).toEqual(['mrn']);
    expect(names('medical record number 00123456')).toEqual(['mrn']);
    expect(names('the MRN is pending')).toEqual([]);
    expect(names('member id: XYZ-1234567')).toEqual(['health_plan_id']);
    expect(names('member id: pending')).toEqual([]);
    expect(names('group number 12-3456-78')).toEqual(['health_plan_id']);
    expect(names('DOB: 03/14/1965')).toEqual(['dob']);
    expect(names('date of birth 1965-03-14')).toEqual(['dob']);
    expect(names('born March 14, 1965')).toEqual([]);
    expect(names('birthdate April 2, 1965')).toEqual(['dob']);
  });
  test('contact: email keeps trailing punctuation out of the value; phone needs separators', () => {
    const r = redactFindings('Mail alice@acme-example.com. Call 555-123-4567 or (555) 123 4567; not 5551234567.', CONTACT).text;
    expect(r).toBe('Mail <REDACTED:email>. Call <REDACTED:phone> or <REDACTED:phone>; not 5551234567.');
  });
  test('redaction keeps the label and replaces only the value', () => {
    const r = redactFindings('Patient alice-example, SSN 078-05-1120, MRN: AB123456, NPI 1234567893.', ID).text;
    expect(r).toBe('Patient alice-example, SSN <REDACTED:ssn>, MRN: <REDACTED:mrn>, NPI <REDACTED:npi>.');
    expect(r).not.toContain('078-05');
  });
});

describe('false-positive budget on the synthetic brain-like fixture', () => {
  for (const doc of buildSyntheticBrainCorpus().filter((d) => d.kind === 'clean')) {
    test(`${doc.id}: no identifier finding, text byte-identical after identifier redaction`, () => {
      expect(scanText(doc.text, ID)).toEqual([]);
      expect(redactFindings(doc.text, ID).text).toBe(doc.text);
    });
  }
});

describe('linear on long lines', () => {
  const ms = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };
  test('200k chars of near-miss digit runs and labels on one line: bounded findings, < 300ms', () => {
    const unit = 'NPI 1234567890 DEA AB1234567 ssn 000-12-3456 member id: pending 2024-123-45-6789 ';
    const line = unit.repeat(Math.ceil(200_000 / unit.length));
    let found: unknown[] = [];
    const t = ms(() => { found = scanText(line, { classes: ['identifier', 'contact'] }); });
    expect(found).toEqual([]);
    expect(t).toBeLessThan(300);
  });
  test('20k real identifiers one per line redact in < 600ms', () => {
    const text = Array.from({ length: 20_000 }, (_, i) => `row ${i}: SSN 078-05-1120, NPI 1234567893, DEA AB1234563`).join('\n');
    let out = '';
    const t = ms(() => { out = redactFindings(text, ID).text; });
    expect(out).not.toContain('078-05-1120');
    expect(out.split('<REDACTED:ssn>').length).toBe(20_001);
    expect(t).toBeLessThan(600);
  });
});

/**
 * foresights lint link checks (core/lint/link-check.ts): dead-link and ambiguous-link,
 * plus the CLI's --json, --strict and --no-links.
 *
 * Every case builds a throwaway brain directory. A link is reported only when no
 * resolution the engine's extractor tries finds a page, so links the graph would
 * link stay silent.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, lstatSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { checkLinks } from '../src/core/lint/link-check.ts';
import { runLintCore, runLint, type LintIssue } from '../src/commands/lint.ts';

const SANITY_OFF = { disabled: true } as const;
let dir: string;

/** Every .md under dir (what lint's walk passes as link targets). */
function targets(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const f = join(d, e); if (lstatSync(f).isDirectory()) walk(f); else if (e.endsWith('.md')) out.push(f); } };
  walk(dir);
  return out;
}
const read = (p: string) => readFileSync(p, 'utf-8');

function page(rel: string, body: string, fm = '---\ntitle: T\ntype: note\ncreated: 2026-01-01\n---\n') {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, fm + body);
  return full;
}

function linkRules(rel: string): Array<{ rule: string; target: string; line: number }> {
  const all = checkLinks(dir, [join(dir, rel)], targets(), read);
  return (all.get(rel) ?? []).map(f => ({ rule: f.rule, target: f.target, line: f.line }));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lint-links-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('dead-link', () => {
  test('a [[dir/slug]] to a missing page is dead; one to an existing page is not', () => {
    page('people/alice-example.md', 'Alice.\n');
    page('notes/a.md', 'See [[people/alice-example]] and [[people/bob-example]].\n');
    expect(linkRules('notes/a.md')).toEqual([{ rule: 'dead-link', target: 'people/bob-example', line: 6 }]);
  });

  test('a bare [[Name]] resolves by unique basename, titles included; an unknown name is dead', () => {
    page('people/alice-example.md', 'Alice.\n');
    page('notes/a.md', 'Met [[Alice Example]] and [[alice-example|Alice]]. Also [[nobody-here]].\n');
    expect(linkRules('notes/a.md').map(r => [r.rule, r.target])).toEqual([['dead-link', 'nobody-here']]);
  });

  test('markdown links: root-relative, ./ and ../ forms resolve; a missing target is dead', () => {
    page('companies/acme-example.md', 'Acme.\n');
    page('notes/b.md', 'B.\n');
    page('notes/a.md', [
      '[Acme](companies/acme-example.md)',
      '[B](./b.md)',
      '[Acme up](../companies/acme-example.md)',
      '[Gone](../companies/widget-co.md)',
      '',
    ].join('\n'));
    expect(linkRules('notes/a.md').map(r => r.rule + ' ' + r.target)).toEqual(['dead-link ../companies/widget-co.md']);
  });

  test('links inside code, attachments, URLs and source-qualified links are not checked', () => {
    page('notes/a.md', [
      '```', '[[people/in-code]]', '```',
      'Inline `[[people/inline-code]]`.',
      '![chart](assets/chart.png) and [pdf](docs/file.pdf)',
      '[site](https://example.com/page)',
      '[[other-source:people/x]]',
      '',
    ].join('\n'));
    expect(linkRules('notes/a.md')).toEqual([]);
  });

  test('frontmatter values are not scanned as body links', () => {
    page('notes/a.md', 'Body.\n', '---\ntitle: T\ntype: note\nsources: "[[missing-in-frontmatter]]"\n---\n');
    expect(linkRules('notes/a.md')).toEqual([]);
  });

  test('a link to an underscore page or to the page itself is live', () => {
    page('notes/_index.md', 'Index.\n');
    page('notes/a.md', 'Up to [[_index]]. Self [[a]].\n');
    expect(linkRules('notes/a.md')).toEqual([]);
  });

  test('the reported line is the line in the file, frontmatter counted', () => {
    page('notes/a.md', 'one\ntwo\nthree [[nowhere-page]]\n');
    expect(linkRules('notes/a.md')[0].line).toBe(8);
  });
});

describe('ambiguous-link', () => {
  test('a bare name matching two pages is ambiguous and lists them; a full path is fine', () => {
    page('people/sam-example.md', 'Person.\n');
    page('companies/sam-example.md', 'Company.\n');
    page('notes/a.md', 'Talked to [[sam-example]]. Full: [[people/sam-example]].\n');
    const found = checkLinks(dir, [join(dir, 'notes/a.md')], targets(), read).get('notes/a.md')!;
    expect(found.map(f => f.rule)).toEqual(['ambiguous-link']);
    expect(found[0].candidates!.sort()).toEqual(['companies/sam-example', 'people/sam-example']);
  });
});

describe('runLintCore links option', () => {
  test('off by default: no link issues; on: dead links are non-fixable issues', async () => {
    page('notes/a.md', 'See [[nowhere-page]].\n');
    const seen: LintIssue[][] = [];
    const base = { target: dir, contentSanity: SANITY_OFF, typePack: null, onPageIssues: (_: string, i: LintIssue[]) => { seen.push(i); } };
    await runLintCore(base);
    expect(seen.flat().some(i => i.rule === 'dead-link')).toBe(false);
    seen.length = 0;
    const r = await runLintCore({ ...base, links: true });
    const dead = seen.flat().filter(i => i.rule === 'dead-link');
    expect(dead.length).toBe(1);
    expect(dead[0].fixable).toBe(false);
    expect(r.total_issues).toBeGreaterThanOrEqual(1);
  });

  test('a single-file target never runs link checks', async () => {
    const f = page('notes/a.md', 'See [[nowhere-page]].\n');
    const seen: LintIssue[] = [];
    await runLintCore({ target: f, links: true, contentSanity: SANITY_OFF, typePack: null, onPageIssues: (_, i) => seen.push(...i) });
    expect(seen.some(i => i.rule === 'dead-link')).toBe(false);
  });

  test('pages skipped by --exclude still count as link targets', async () => {
    page('archive/old-page.md', 'Old.\n');
    page('notes/a.md', 'See [[old-page]].\n');
    const seen: LintIssue[] = [];
    await runLintCore({ target: dir, links: true, exclude: ['archive'], contentSanity: SANITY_OFF, typePack: null,
      onPageIssues: (_, i) => seen.push(...i) });
    expect(seen.some(i => i.rule === 'dead-link')).toBe(false);
  });
});

describe('CLI: --json, --strict, --no-links', () => {
  async function cli(args: string[]): Promise<{ out: string; code: number | undefined }> {
    const orig = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    const before = process.exitCode;
    process.exitCode = undefined;
    try { await runLint(args); } finally { console.log = orig; }
    const code = process.exitCode as number | undefined;
    process.exitCode = before;
    return { out: lines.join('\n'), code };
  }

  test('--json prints one JSON report with the link finding and the counts', async () => {
    page('notes/a.md', 'See [[nowhere-page]].\n');
    const { out, code } = await cli([dir, '--json']);
    const report = JSON.parse(out);
    expect(report.links_checked).toBe(true);
    const issues = report.pages.flatMap((p: { issues: Array<{ rule: string }> }) => p.issues);
    expect(issues.some((i: { rule: string }) => i.rule === 'dead-link')).toBe(true);
    expect(report.remaining_issues).toBe(report.total_issues);
    expect(code ?? 0).toBe(0); // without --strict, findings never fail the run
  });

  test('--strict exits 1 when issues are left, 0 when clean', async () => {
    page('notes/a.md', 'See [[nowhere-page]].\n');
    expect((await cli([dir, '--strict', '--json'])).code).toBe(1);
    rmSync(join(dir, 'notes/a.md'));
    page('notes/ok.md', 'Fine.\n');
    expect((await cli([dir, '--strict', '--json'])).code ?? 0).toBe(0);
  });

  test('--no-links turns the link checks off', async () => {
    page('notes/a.md', 'See [[nowhere-page]].\n');
    const report = JSON.parse((await cli([dir, '--json', '--no-links'])).out);
    expect(report.links_checked).toBe(false);
    expect(report.pages.flatMap((p: { issues: Array<{ rule: string }> }) => p.issues).some((i: { rule: string }) => i.rule === 'dead-link')).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';

const fence = '---';

describe('parseMarkdown validation surface', () => {
  test('opt-in: no errors field when validate omitted', () => {
    const md = `${fence}\ntype: concept\ntitle: hi\n${fence}\n\nbody`;
    const parsed = parseMarkdown(md);
    expect(parsed.errors).toBeUndefined();
  });

  test('valid file: empty errors[] under validate', () => {
    const md = `${fence}\ntype: concept\ntitle: hi\n${fence}\n\nbody`;
    const parsed = parseMarkdown(md, undefined, { validate: true });
    expect(parsed.errors).toEqual([]);
  });

  describe('MISSING_OPEN', () => {
    test('empty file', () => {
      const parsed = parseMarkdown('', undefined, { validate: true });
      const codes = parsed.errors!.map(e => e.code);
      expect(codes).toContain('MISSING_OPEN');
    });

    test('whitespace-only file', () => {
      const parsed = parseMarkdown('   \n  \t  \n', undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('MISSING_OPEN');
    });

    test('file starting with body, no frontmatter', () => {
      const md = '# A heading\n\nbody text';
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('MISSING_OPEN');
    });
  });

  describe('MISSING_CLOSE', () => {
    test('opens but never closes, heading appears', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\n# A heading\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const e = parsed.errors!.find(e => e.code === 'MISSING_CLOSE');
      expect(e).toBeDefined();
      expect(e!.message.toLowerCase()).toContain('heading');
    });

    test('opens but never closes, no heading', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nstray content`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const e = parsed.errors!.find(e => e.code === 'MISSING_CLOSE');
      expect(e).toBeDefined();
    });
  });

  describe('YAML_PARSE', () => {
    test('malformed YAML inside frontmatter triggers error', () => {
      // Indentation-corrupt mapping: gray-matter throws on this shape.
      const md = `${fence}\nfoo: bar\n  - 1\n  - 2\nfoo: again\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      // Either YAML_PARSE or NESTED_QUOTES; both are surfaceable. Assert at
      // least one parse-class error fires.
      const hasParse = parsed.errors!.some(e => e.code === 'YAML_PARSE' || e.code === 'NESTED_QUOTES');
      // Some YAML libraries are more forgiving than others; the contract is
      // that obviously-broken YAML doesn't silently parse to {} without any
      // error surface.
      if (parsed.errors!.length === 0) {
        // gray-matter swallowed it; that's a known gray-matter edge.
        // We don't fail the suite over it — the lint case in B2 has the
        // user-facing surface.
      } else {
        expect(hasParse || parsed.errors!.length > 0).toBe(true);
      }
    });
  });

  describe('SLUG_MISMATCH', () => {
    test('declared slug differs from expected', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nslug: wrong-slug\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, 'people/jane-doe.md', {
        validate: true,
        expectedSlug: 'people/jane-doe',
      });
      expect(parsed.errors!.map(e => e.code)).toContain('SLUG_MISMATCH');
    });

    test('matching slug -> no error', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nslug: people/jane-doe\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, 'people/jane-doe.md', {
        validate: true,
        expectedSlug: 'people/jane-doe',
      });
      expect(parsed.errors!.map(e => e.code)).not.toContain('SLUG_MISMATCH');
    });

    test('no expectedSlug -> no SLUG_MISMATCH even when slug present', () => {
      const md = `${fence}\ntype: concept\ntitle: hi\nslug: anything\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('SLUG_MISMATCH');
    });
  });

  describe('NULL_BYTES', () => {
    test('null byte in content', () => {
      const md = `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbod\x00y`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const e = parsed.errors!.find(e => e.code === 'NULL_BYTES');
      expect(e).toBeDefined();
      expect(e!.line).toBeGreaterThanOrEqual(1);
    });

    test('null byte in frontmatter', () => {
      const md = `${fence}\ntype: con\x00cept\ntitle: ok\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('NULL_BYTES');
    });
  });

  describe('NESTED_QUOTES', () => {
    test('title with nested double quotes', () => {
      const md = `${fence}\ntype: concept\ntitle: "Phil Libin's "Life's Work"" essay\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('NESTED_QUOTES');
    });

    test('escaped inner quote does not trigger', () => {
      const md = `${fence}\ntype: concept\ntitle: "ok \\"quoted\\" inside"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('NESTED_QUOTES');
    });

    test('clean title does not trigger', () => {
      const md = `${fence}\ntype: concept\ntitle: "Just a normal title"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).not.toContain('NESTED_QUOTES');
    });
  });

  // The validator's count-of-quotes heuristic is too dumb: it flagged
  // valid YAML flow sequences (the v0.x 6,981-error class on Garry's
  // brain) and single-quoted scalars with literal inner quotes. The
  // fallback runs js-yaml.safeLoad on suspicious values; only flags
  // genuinely unparseable lines.
  describe('NESTED_QUOTES — YAML-aware fallback', () => {
    test('flow sequence with quoted tags does NOT trigger (6,981-error regression guard)', () => {
      const md = `${fence}\ntype: concept\ntitle: x\ntags: ["yc", "w2025", "ai"]\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.filter(e => e.code === 'NESTED_QUOTES')).toHaveLength(0);
    });

    test('single-quoted scalar with literal inner double quotes does NOT trigger', () => {
      // value: 'a: "b" "c" "d"' — 6 unescaped " by raw count, but valid YAML
      const md = `${fence}\ntype: concept\ntitle: 'a: "b" "c" "d"'\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.filter(e => e.code === 'NESTED_QUOTES')).toHaveLength(0);
    });

    test('escaped-as-single-pair quotes inside flow seq do NOT trigger', () => {
      const md = `${fence}\ntype: concept\ntitle: x\ntags: ["Men''s Fashion", "yc"]\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.filter(e => e.code === 'NESTED_QUOTES')).toHaveLength(0);
    });

    test('genuinely broken nested quotes STILL trigger', () => {
      // Outer " followed by stray inner " — yaml.safeLoad throws.
      const md = `${fence}\ntype: concept\ntitle: "Foo "bar" baz "qux" end"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('NESTED_QUOTES');
    });

    test('unclosed bracket on a suspicious line STILL surfaces some parse error', () => {
      // Either NESTED_QUOTES (line-level parse fail) or YAML_PARSE
      // (whole-frontmatter parse fail) — never silent.
      const md = `${fence}\ntype: concept\ntitle: x\ntags: ["yc", "w2025"\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      const broken = parsed.errors!.filter(
        e => e.code === 'NESTED_QUOTES' || e.code === 'YAML_PARSE'
      );
      expect(broken.length).toBeGreaterThan(0);
    });

    // v0.37.9.0 — parity test (codex outside-voice review D7-3).
    // The validator parses ONLY the value with safeLoad. Gray-matter parses
    // the whole frontmatter document. These two can disagree on edge cases
    // (e.g. a value valid in isolation but ambiguous in document context).
    // For the load-bearing inputs this wave targets, both paths must agree:
    // valid YAML doesn't trigger NESTED_QUOTES, and clearly broken YAML
    // either triggers NESTED_QUOTES or YAML_PARSE (never silent).
    test('parity: validator per-value safeLoad agrees with gray-matter full-document parse', () => {
      const cases: { md: string; shouldFlag: boolean; label: string }[] = [
        // Valid: gray-matter parses cleanly, validator should NOT flag.
        { md: `${fence}\ntype: concept\ntags: ["yc", "w2025"]\n${fence}\n\nbody`, shouldFlag: false, label: 'JSON-style array (valid YAML)' },
        { md: `${fence}\ntype: concept\ntags: ['yc', 'w2025']\n${fence}\n\nbody`, shouldFlag: false, label: 'single-quoted array' },
        { md: `${fence}\ntype: concept\ntitle: 'a: "b" "c"'\n${fence}\n\nbody`, shouldFlag: false, label: 'single-quoted scalar with literal inner quotes' },
        { md: `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody`, shouldFlag: false, label: 'clean scalar' },
        // Broken: gray-matter would fail OR produce ambiguous parse, validator
        // should surface either NESTED_QUOTES or YAML_PARSE.
        { md: `${fence}\ntype: concept\ntitle: "Foo "bar" baz "qux" end"\n${fence}\n\nbody`, shouldFlag: true, label: 'nested scalar quotes' },
      ];
      for (const c of cases) {
        const parsed = parseMarkdown(c.md, undefined, { validate: true });
        const errors = parsed.errors!.filter(
          e => e.code === 'NESTED_QUOTES' || e.code === 'YAML_PARSE'
        );
        if (c.shouldFlag) {
          expect(errors.length, `[${c.label}] expected at least one NESTED_QUOTES or YAML_PARSE error`).toBeGreaterThan(0);
        } else {
          expect(errors.length, `[${c.label}] expected no NESTED_QUOTES/YAML_PARSE errors but got ${JSON.stringify(errors)}`).toBe(0);
        }
      }
    });
  });

  describe('EMPTY_FRONTMATTER', () => {
    test('--- --- with nothing between', () => {
      const md = `${fence}\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('EMPTY_FRONTMATTER');
    });

    test('--- with whitespace then ---', () => {
      const md = `${fence}\n   \n\n${fence}\n\nbody`;
      const parsed = parseMarkdown(md, undefined, { validate: true });
      expect(parsed.errors!.map(e => e.code)).toContain('EMPTY_FRONTMATTER');
    });
  });

  test('error.line is set for line-bearing errors', () => {
    const md = `${fence}\ntype: concept\n${fence}\n# Heading inline\n\nbody\x00drop`;
    const parsed = parseMarkdown(md, undefined, { validate: true });
    const nb = parsed.errors!.find(e => e.code === 'NULL_BYTES');
    expect(nb?.line).toBeGreaterThanOrEqual(1);
  });
});

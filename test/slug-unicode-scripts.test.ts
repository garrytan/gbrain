import { describe, test, expect } from 'bun:test';
import { slugifySegment, slugifyPath } from '../src/core/sync.ts';
import { validatePageSlug } from '../src/core/operations.ts';
import { isValidHolder } from '../src/core/takes-fence.ts';

/**
 * #3417 — silent data loss for non-Latin, non-CJK scripts.
 *
 * Pre-fix, slugifySegment stripped every character outside [a-z0-9._-] + CJK,
 * so whole filenames in Hebrew / Arabic / Cyrillic / Greek / Thai collapsed to
 * empty segments. Distinct files then mapped to the SAME slug (their shared
 * directory prefix) and last-writer-wins overwrote each other with `import`
 * reporting 0 errors.
 *
 * Every assertion here is behavioral (input → output), so this file FAILS on
 * pre-fix master and passes with the Unicode-property-escape grammar.
 */

describe('#3417: non-Latin scripts survive slugification', () => {
  // The six script families from the issue, before/after.
  const cases: Array<[string, string, string]> = [
    ['Hebrew', 'notes/רשימת קניות.md', 'notes/רשימת-קניות'],
    ['Arabic', 'notes/قائمة المهام.md', 'notes/قائمة-المهام'],
    ['Cyrillic', 'notes/Список задач.md', 'notes/список-задач'],
    // Greek: tonos marks decompose to U+0301 under NFD and are stripped by the
    // same combining-accent pass that turns café → cafe. Consistent, stable.
    ['Greek', 'notes/Λίστα εργασιών.md', 'notes/λιστα-εργασιων'],
    ['Thai', 'notes/รายการซื้อของ.md', 'notes/รายการซื้อของ'],
    ['Hebrew + digits', 'notes/תוכנית עבודה 2026.md', 'notes/תוכנית-עבודה-2026'],
  ];

  for (const [name, input, expected] of cases) {
    test(`${name}: ${input} → ${expected}`, () => {
      expect(slugifyPath(input)).toBe(expected);
    });
  }

  test('distinct same-directory files no longer collapse onto one slug', () => {
    // Pre-fix ALL of these slugified to "notes" — one page, last writer wins.
    const slugs = [
      slugifyPath('notes/רשימת קניות.md'),
      slugifyPath('notes/قائمة المهام.md'),
      slugifyPath('notes/Список задач.md'),
      slugifyPath('notes/Λίστα εργασιών.md'),
      slugifyPath('notes/รายการซื้อของ.md'),
    ];
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).not.toBe('notes');
  });

  test('emitted slugs are ACCEPTED by validatePageSlug (three-grammar coherence)', () => {
    // The trap: fixing only sync.ts makes sync emit slugs put_page rejects.
    for (const [, input] of cases) {
      const slug = slugifyPath(input);
      expect(() => validatePageSlug(slug)).not.toThrow();
    }
  });

  test('takes-fence holder grammar accepts non-Latin slugs', () => {
    expect(isValidHolder('people/גארי-כהן')).toBe(true);
    expect(isValidHolder('companies/شركة-مثال')).toBe(true);
    // Uppercase still rejected (lowercase-canonical contract preserved).
    expect(isValidHolder('people/Garry-Tan')).toBe(false);
  });
});

describe('#3417: normalization — NFD (macOS) and NFC (git/Linux) converge', () => {
  test('Hebrew NFD filename produces the same slug as NFC', () => {
    const nfc = 'notes/רשימת קניות.md'.normalize('NFC');
    const nfd = 'notes/רשימת קניות.md'.normalize('NFD');
    expect(slugifyPath(nfd)).toBe(slugifyPath(nfc));
  });

  test('Vietnamese NFD filename produces the same slug as NFC', () => {
    const nfc = 'notes/người dùng.md'.normalize('NFC');
    const nfd = 'notes/người dùng.md'.normalize('NFD');
    expect(slugifyPath(nfd)).toBe(slugifyPath(nfc));
  });
});

describe('#3417: regressions — existing behavior unchanged', () => {
  test('ASCII kebab-casing, lowercasing, dots, underscores', () => {
    expect(slugifyPath('notes/Shopping List.md')).toBe('notes/shopping-list');
    expect(slugifyPath('notes/v1.0.0.md')).toBe('notes/v1.0.0');
    expect(slugifySegment('my_file_name')).toBe('my_file_name');
    expect(slugifySegment('notes (march 2024)')).toBe('notes-march-2024');
  });

  test('Latin accents still strip (café → cafe)', () => {
    expect(slugifySegment('café résumé')).toBe('cafe-resume');
  });

  test('CJK still preserved', () => {
    expect(slugifyPath('notes/购物清单.md')).toBe('notes/购物清单');
    expect(slugifyPath('inbox/品牌圣经.md')).toBe('inbox/品牌圣经');
    expect(slugifySegment('한글테스트'.normalize('NFD'))).toBe('한글테스트');
  });

  test('all-symbol input still collapses to empty (frontmatter-fallback path intact)', () => {
    expect(slugifySegment('!!!')).toBe('');
    expect(slugifySegment('🎉🎉')).toBe('');
  });

  test('control chars, RTL override, punctuation still stripped', () => {
    expect(slugifySegment('evil‮gnp')).toBe('evilgnp');
    expect(slugifySegment('a\u0000b')).toBe('ab');
  });

  test('validatePageSlug still rejects traversal, backslash, RTL override, uppercase-only weirdness', () => {
    expect(() => validatePageSlug('../etc/passwd')).toThrow();
    expect(() => validatePageSlug('notes\\file')).toThrow();
    expect(() => validatePageSlug('notes/‮evil')).toThrow();
    expect(() => validatePageSlug('notes/a\u0007b')).toThrow();
  });
});

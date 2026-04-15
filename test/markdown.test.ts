import { describe, test, expect } from 'bun:test';
import { parseMarkdown, serializeMarkdown, splitBody } from '../src/core/markdown.ts';

describe('Markdown Parser', () => {
  test('parses frontmatter + compiled_truth + timeline', () => {
    const md = `---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth]
---

Paul Graham argues that startups should do unscalable things early on.

---

- 2013-07-01: Published on paulgraham.com
- 2024-11-15: Referenced in batch kickoff talk
`;
    const parsed = parseMarkdown(md);
    expect(parsed.type).toBe('concept');
    expect(parsed.title).toBe("Do Things That Don't Scale");
    expect(parsed.tags).toEqual(['startups', 'growth']);
    expect(parsed.compiled_truth).toContain('unscalable things');
    expect(parsed.timeline).toContain('Published on paulgraham.com');
    expect(parsed.timeline).toContain('batch kickoff talk');
  });

  test('handles no timeline separator', () => {
    const md = `---
type: concept
title: Superlinear Returns
---

Returns in many fields are superlinear.
Performance compounds over time.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('superlinear');
    expect(parsed.timeline).toBe('');
  });

  test('handles empty body', () => {
    const md = `---
type: concept
title: Empty Page
---
`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toBe('');
    expect(parsed.timeline).toBe('');
  });

  test('removes type, title, tags from frontmatter object', () => {
    const md = `---
type: concept
title: Test
tags: [a, b]
custom_field: hello
---

Content
`;
    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter).not.toHaveProperty('type');
    expect(parsed.frontmatter).not.toHaveProperty('title');
    expect(parsed.frontmatter).not.toHaveProperty('tags');
    expect(parsed.frontmatter).toHaveProperty('custom_field', 'hello');
  });

  test('infers type from file path', () => {
    const md = `---
title: Someone
---
Content
`;
    const parsed = parseMarkdown(md, 'people/someone.md');
    expect(parsed.type).toBe('person');
  });

  test('infers slug from file path', () => {
    const md = `---
type: concept
title: Test
---
Content
`;
    const parsed = parseMarkdown(md, 'concepts/do-things-that-dont-scale.md');
    expect(parsed.slug).toBe('concepts/do-things-that-dont-scale');
  });
});

describe('splitBody', () => {
  test('splits at first standalone ---', () => {
    const body = 'Above the line\n\n---\n\nBelow the line';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Above the line');
    expect(timeline).toContain('Below the line');
  });

  test('returns all as compiled_truth if no separator', () => {
    const body = 'Just some content\nWith multiple lines';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('handles --- at end of content', () => {
    const body = 'Content here\n\n---\n';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Content here');
    expect(timeline.trim()).toBe('');
  });
});

describe('serializeMarkdown', () => {
  test('round-trips through parse and serialize', () => {
    const original = `---
type: concept
title: Do Things That Don't Scale
tags:
  - startups
  - growth
custom: value
---

Paul Graham argues that startups should do unscalable things early on.

---

- 2013-07-01: Published on paulgraham.com
`;
    const parsed = parseMarkdown(original);
    const serialized = serializeMarkdown(
      parsed.frontmatter,
      parsed.compiled_truth,
      parsed.timeline,
      { type: parsed.type, title: parsed.title, tags: parsed.tags },
    );

    // Re-parse the serialized version
    const reparsed = parseMarkdown(serialized);
    expect(reparsed.type).toBe(parsed.type);
    expect(reparsed.title).toBe(parsed.title);
    expect(reparsed.compiled_truth).toBe(parsed.compiled_truth);
    expect(reparsed.timeline).toBe(parsed.timeline);
    expect(reparsed.frontmatter.custom).toBe('value');
  });
});

describe('parseMarkdown edge cases', () => {
  test('handles content with multiple --- separators', () => {
    const md = `---
type: concept
title: Test
---

First section.

---

Timeline part 1.

---

More timeline.`;
    const parsed = parseMarkdown(md);
    // Only splits at the FIRST standalone ---
    expect(parsed.compiled_truth.trim()).toBe('First section.');
    expect(parsed.timeline).toContain('Timeline part 1.');
    expect(parsed.timeline).toContain('More timeline.');
  });

  test('handles frontmatter without type or title', () => {
    const md = `---
custom_field: hello
---

Some content.`;
    const parsed = parseMarkdown(md);
    expect(parsed.type).toBeTruthy(); // should have a default
    expect(parsed.compiled_truth.trim()).toBe('Some content.');
    expect(parsed.frontmatter.custom_field).toBe('hello');
  });

  test('handles content with no frontmatter at all', () => {
    const md = `Just plain text with no YAML.`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('Just plain text');
  });

  test('handles empty string', () => {
    const parsed = parseMarkdown('');
    expect(parsed.compiled_truth).toBe('');
    expect(parsed.timeline).toBe('');
  });

  test('infers type from various directory paths', () => {
    expect(parseMarkdown('', 'people/someone.md').type).toBe('person');
    expect(parseMarkdown('', 'concepts/thing.md').type).toBe('concept');
    expect(parseMarkdown('', 'companies/acme.md').type).toBe('company');
    expect(parseMarkdown('', 'systems/llvm.md').type).toBe('system');
  });

  test('preserves codemap frontmatter as structured data', () => {
    const md = `---
type: concept
title: Operator Fusion
codemap:
  - system: systems/pytorch
    pointers:
      - path: torch/_inductor/fx_passes/group_fusion.py
        symbol: group_fusion_passes()
        role: Identifies fusible FX subgraphs
        verified_at: 2026-04-15
    vocabulary: fusion group
---

Compiled truth.
`;

    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter.codemap).toEqual([
      {
        system: 'systems/pytorch',
        pointers: [
          {
            path: 'torch/_inductor/fx_passes/group_fusion.py',
            symbol: 'group_fusion_passes()',
            role: 'Identifies fusible FX subgraphs',
            verified_at: '2026-04-15',
          },
        ],
        vocabulary: 'fusion group',
      },
    ]);
  });

  test('only normalizes codemap verified_at dates and leaves unrelated timestamps untouched', () => {
    const md = `---
type: concept
title: LLVM Pipelines
reviewed_at: 2026-04-15T12:30:00-07:00
codemap:
  - system: systems/llvm
    pointers:
      - path: llvm/lib/Passes/PassBuilder.cpp
        symbol: PassBuilder::buildPerModuleDefaultPipeline()
        role: Builds the default optimization pipeline
        verified_at: 2026-04-15
---

Compiled truth.
`;

    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter.reviewed_at).toBeInstanceOf(Date);
    expect(parsed.frontmatter.codemap).toEqual([
      {
        system: 'systems/llvm',
        pointers: [
          {
            path: 'llvm/lib/Passes/PassBuilder.cpp',
            symbol: 'PassBuilder::buildPerModuleDefaultPipeline()',
            role: 'Builds the default optimization pipeline',
            verified_at: '2026-04-15',
          },
        ],
      },
    ]);
  });

  test('round-trips system page frontmatter with codemap metadata intact', () => {
    const original = `---
type: system
title: LLVM
repo: https://github.com/llvm/llvm-project
language:
  - C++
build_command: cmake -G Ninja ../llvm && ninja
test_command: ninja check-llvm
key_entry_points:
  - name: Pass builder
    path: llvm/lib/Passes/PassBuilder.cpp
    purpose: Builds optimization pipelines
codemap:
  - system: systems/llvm
    pointers:
      - path: llvm/lib/Transforms/InstCombine/InstructionCombining.cpp
        symbol: InstCombinerImpl::run()
        role: Fuses adjacent IR instructions
        verified_at: 2026-04-15
---

Architecture summary.
`;

    const parsed = parseMarkdown(original, 'systems/llvm.md');
    const serialized = serializeMarkdown(
      parsed.frontmatter,
      parsed.compiled_truth,
      parsed.timeline,
      { type: parsed.type, title: parsed.title, tags: parsed.tags },
    );
    const reparsed = parseMarkdown(serialized, 'systems/llvm.md');

    expect(reparsed.type).toBe('system');
    expect(reparsed.frontmatter.repo).toBe('https://github.com/llvm/llvm-project');
    expect(reparsed.frontmatter.build_command).toBe('cmake -G Ninja ../llvm && ninja');
    expect(reparsed.frontmatter.test_command).toBe('ninja check-llvm');
    expect(reparsed.frontmatter.key_entry_points).toEqual([
      {
        name: 'Pass builder',
        path: 'llvm/lib/Passes/PassBuilder.cpp',
        purpose: 'Builds optimization pipelines',
      },
    ]);
    expect(reparsed.frontmatter.codemap).toEqual([
      {
        system: 'systems/llvm',
        pointers: [
          {
            path: 'llvm/lib/Transforms/InstCombine/InstructionCombining.cpp',
            symbol: 'InstCombinerImpl::run()',
            role: 'Fuses adjacent IR instructions',
            verified_at: '2026-04-15',
          },
        ],
      },
    ]);
  });
});

import { describe, test, expect } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';

describe('Domain import frontmatter extensions', () => {
  test('Valid frontmatter with confidence, source, type parses correctly', () => {
    const md = `---
type: person
title: Anna Example
source: linkedin-import
confidence: 0.85
tags: [person:anna, company:ExampleCorp]
---
Anna is the CEO of ExampleCorp.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.confidence).toBe(0.85);
    expect(parsed.source).toBe('linkedin-import');
    expect(parsed.type).toBe('person');
    expect(parsed.tags).toContain('person:anna');
    expect(parsed.warnings).toHaveLength(0);
  });

  test('Missing source produces warning', () => {
    const md = `---
type: concept
title: Test
---
Content without source.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.source).toBeUndefined();
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.warnings.some(w => w.field === 'source')).toBe(true);
  });

  test('Invalid confidence falls back to default with warning', () => {
    const md = `---
type: concept
title: Test
source: manual
confidence: 2.5
---
Content with bad confidence.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.confidence).toBe(0.8);
    const warn = parsed.warnings.find(w => w.field === 'confidence');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('out of range');
    expect(warn!.fallback).toBe(0.8);
  });

  test('Negative confidence falls back to default with warning', () => {
    const md = `---
type: concept
title: Test
source: manual
confidence: -0.5
---
Content with negative confidence.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.confidence).toBe(0.8);
    const warn = parsed.warnings.find(w => w.field === 'confidence');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('out of range');
  });

  test('Non-numeric confidence falls back to default with warning', () => {
    const md = `---
type: concept
title: Test
source: manual
confidence: high
---
Content with string confidence.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.confidence).toBe(0.8);
    const warn = parsed.warnings.find(w => w.field === 'confidence');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('must be a number');
  });

  test('Unknown type produces warning', () => {
    const md = `---
type: banana
title: Test
source: manual
---
Content with unknown type.
`;
    const parsed = parseMarkdown(md);
    // Should not crash; should fall back to inferred type ('concept')
    expect(parsed.type).toBe('concept');
    const warn = parsed.warnings.find(w => w.field === 'type');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('banana');
  });

  test('Unknown type in known directory falls back to inferred path type', () => {
    const md = `---
type: banana
title: Someone
source: manual
---
Content.
`;
    const parsed = parseMarkdown(md, 'people/someone.md');
    expect(parsed.type).toBe('person');
    const warn = parsed.warnings.find(w => w.field === 'type');
    expect(warn).toBeDefined();
  });

  test('Colon-format tags are preserved', () => {
    const md = `---
type: project
title: GBrain
source: dev
tags: [person:anna, project:gbrain, company:ExampleCorp]
---
Project content.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.tags).toContain('person:anna');
    expect(parsed.tags).toContain('project:gbrain');
    expect(parsed.tags).toContain('company:ExampleCorp');
    expect(parsed.tags).toHaveLength(3);
  });

  test('Consent field is parsed', () => {
    const md = `---
type: concept
title: Voice Note
source: voice
consent: true
---
Content.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.consent).toBe(true);
  });

  test('Consent field false is parsed', () => {
    const md = `---
type: concept
title: Voice Note
source: voice
consent: false
---
Content.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.consent).toBe(false);
  });

  test('Consent field absent is undefined', () => {
    const md = `---
type: concept
title: Test
source: web
---
Content.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.consent).toBeUndefined();
  });

  test('Default confidence is 0.8 when absent', () => {
    const md = `---
type: concept
title: Test
source: web
---
Content.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.confidence).toBe(0.8);
  });

  test('voice_session type is valid', () => {
    const md = `---
type: voice_session
title: Standup 2026-04-10
source: voice-note
confidence: 0.7
---
Recording transcript here.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.type).toBe('voice_session');
    expect(parsed.warnings).toHaveLength(0);
  });

  test('meeting type is valid', () => {
    const md = `---
type: meeting
title: Q1 Board Meeting
source: manual
---
Meeting notes.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.type).toBe('meeting');
    expect(parsed.warnings).toHaveLength(0);
  });

  test('Source and confidence are stripped from clean frontmatter', () => {
    const md = `---
type: concept
title: Test
source: web
confidence: 0.9
consent: true
custom_field: hello
---
Content.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter).not.toHaveProperty('source');
    expect(parsed.frontmatter).not.toHaveProperty('confidence');
    expect(parsed.frontmatter).not.toHaveProperty('consent');
    expect(parsed.frontmatter).toHaveProperty('custom_field', 'hello');
  });
});

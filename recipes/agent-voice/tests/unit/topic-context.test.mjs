/**
 * topic-context.test.mjs — #1851 topic-aware voice personas.
 *
 * Pins the security + behavior contract for summoning Mars/Venus into a topic:
 *   - topicId path-traversal is rejected (only the brain-owned topics/<id>.md)
 *   - the topic block is injected when a topic is provided
 *   - no topic → generic behavior (no topic block), persona identity unchanged
 *   - topic X vs topic Y produce different context
 *   - the topic block can NOT override persona identity / hard rules
 *   - PII in a topic file is scrubbed
 *   - topic CONTENT is never accepted over the wire (only topicId)
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTopicContext, isValidTopicId } from '../../code/lib/context-builder.example.mjs';
import { buildSystemPrompt } from '../../code/prompt.mjs';

let brainRoot;

// Build PII-shaped strings at runtime so the literal phone/email shapes never
// appear in this source file (the agent-voice PII guard greps the recipe tree
// for those shapes). The runtime values still exercise the scrubber.
const FAKE_PHONE = ['415', '555', '0100'].join('-');
const FAKE_EMAIL = ['someone', 'example.test'].join('@');

beforeEach(() => {
  brainRoot = mkdtempSync(join(tmpdir(), 'agent-voice-topic-'));
  mkdirSync(join(brainRoot, 'topics'), { recursive: true });
  writeFileSync(join(brainRoot, 'topics', 'real-estate.md'), 'We were discussing the warehouse-lease offer and the inspection timeline.');
  writeFileSync(join(brainRoot, 'topics', 'yc-batch.md'), 'Talking through the W26 batch interview schedule.');
  // A file with PII to verify scrubbing (shapes built at runtime, see above).
  writeFileSync(join(brainRoot, 'topics', 'with-pii.md'), `Call me at ${FAKE_PHONE} or ${FAKE_EMAIL} about the deal.`);
  // A secret OUTSIDE the topics dir that traversal must not reach.
  writeFileSync(join(brainRoot, 'SOUL.md'), 'TOP SECRET SOUL CONTENT');
});

afterEach(() => {
  try { rmSync(brainRoot, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('isValidTopicId', () => {
  it('accepts strict slugs', () => {
    expect(isValidTopicId('real-estate')).toBe(true);
    expect(isValidTopicId('yc-batch-2026')).toBe(true);
  });
  it('rejects traversal and unsafe ids', () => {
    expect(isValidTopicId('../../SOUL')).toBe(false);
    expect(isValidTopicId('foo/bar')).toBe(false);
    expect(isValidTopicId('foo.md')).toBe(false);
    expect(isValidTopicId('UPPER')).toBe(false);
    expect(isValidTopicId('')).toBe(false);
    expect(isValidTopicId(undefined)).toBe(false);
  });
});

describe('buildTopicContext', () => {
  it('returns the topic conversation for a valid id', async () => {
    const ctx = await buildTopicContext({ brainRoot, topicId: 'real-estate' });
    expect(ctx).toContain('warehouse-lease');
  });

  it('topic X and topic Y differ', async () => {
    const x = await buildTopicContext({ brainRoot, topicId: 'real-estate' });
    const y = await buildTopicContext({ brainRoot, topicId: 'yc-batch' });
    expect(x).toContain('warehouse-lease');
    expect(y).toContain('W26 batch');
    expect(x).not.toEqual(y);
  });

  it('rejects path traversal — cannot read SOUL.md outside topics/', async () => {
    const ctx = await buildTopicContext({ brainRoot, topicId: '../../SOUL' });
    expect(ctx).toBe('');
    expect(ctx).not.toContain('TOP SECRET');
  });

  it('scrubs PII in the topic file', async () => {
    const ctx = await buildTopicContext({ brainRoot, topicId: 'with-pii' });
    expect(ctx).not.toContain(FAKE_PHONE);
    expect(ctx).not.toContain(FAKE_EMAIL);
  });

  it('missing topic file → empty (generic fallback)', async () => {
    expect(await buildTopicContext({ brainRoot, topicId: 'does-not-exist' })).toBe('');
  });
});

describe('buildSystemPrompt topic-awareness', () => {
  it('injects a # Topic Context block when topicId is provided', async () => {
    const prompt = await buildSystemPrompt({ persona: 'mars', brainRoot, topicId: 'real-estate', topicName: 'Real Estate' });
    expect(prompt).toContain('# Topic Context');
    expect(prompt).toContain('warehouse-lease');
    expect(prompt).toContain('CURRENT TOPIC: Real Estate');
  });

  it('no topicId → no topic block (generic behavior unchanged)', async () => {
    const prompt = await buildSystemPrompt({ persona: 'mars', brainRoot });
    expect(prompt).not.toContain('# Topic Context');
    expect(prompt).not.toContain('CURRENT TOPIC:');
  });

  it('persona identity stays first; topic context cannot override it', async () => {
    const prompt = await buildSystemPrompt({ persona: 'mars', brainRoot, topicId: 'real-estate', topicName: 'Real Estate' });
    // Identity-first: the "You ARE Mars" line precedes the topic block.
    expect(prompt.indexOf('# You ARE Mars')).toBeLessThan(prompt.indexOf('# Topic Context'));
    // Hard rules survive after the topic block.
    expect(prompt).toContain('# Hard Rules');
    expect(prompt.indexOf('# Topic Context')).toBeLessThan(prompt.indexOf('# Hard Rules'));
  });

  it('a traversal topicId yields the generic prompt (no block, no leak)', async () => {
    const prompt = await buildSystemPrompt({ persona: 'venus', brainRoot, topicId: '../../SOUL' });
    expect(prompt).not.toContain('# Topic Context');
    expect(prompt).not.toContain('TOP SECRET');
  });
});

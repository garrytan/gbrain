import { describe, test, expect } from 'bun:test';
import {
  validateMemoryNode,
  validateRelation,
  validateVoiceSession,
  ValidationError,
  type MemoryNode,
  type Relation,
  type VoiceSession,
} from './domain.ts';

function validMemoryNode(): Partial<MemoryNode> {
  return {
    id: 'node-1',
    slug: 'anna-ExampleCorp',
    type: 'person',
    title: 'Anna Example',
    summary: 'CEO of ExampleCorp',
    source: 'linkedin-import',
    confidence: 0.85,
    consent: true,
    created_at: '2026-01-15T10:00:00Z',
    last_verified_at: '2026-03-01T08:00:00Z',
    tags: ['person:anna', 'company:ExampleCorp'],
    metadata: { role: 'CEO' },
  };
}

function validRelation(): Partial<Relation> {
  return {
    from_slug: 'anna-ExampleCorp',
    to_slug: 'ExampleCorp',
    relation_type: 'works_at',
    confidence: 0.9,
    context: 'CEO role at the company',
    source: 'linkedin-import',
    created_at: '2026-02-01T12:00:00Z',
  };
}

function validVoiceSession(): Partial<VoiceSession> {
  return {
    id: 'voice-001',
    transcript: 'Anna mentioned the new funding round.',
    answer: 'Anna Example is CEO of ExampleCorp which recently raised a Series A.',
    summary: 'Key update about ExampleCorp funding',
    tags: ['funding', 'meeting'],
    source: 'voice-note',
    consent: true,
    confidence: 0.75,
    created_at: '2026-04-10T14:30:00Z',
    duration_ms: 45000,
    page_slug: 'meetings/2026-04-10-funding',
  };
}

describe('validateMemoryNode', () => {
  test('valid MemoryNode with all fields passes', () => {
    const result = validateMemoryNode(validMemoryNode());
    expect(result.id).toBe('node-1');
    expect(result.type).toBe('person');
    expect(result.confidence).toBe(0.85);
    expect(result.source).toBe('linkedin-import');
    expect(Array.isArray(result.tags)).toBe(true);
    expect(result.metadata.role).toBe('CEO');
  });

  test('MemoryNode without source throws', () => {
    const data = { ...validMemoryNode(), source: undefined };
    expect(() => validateMemoryNode(data)).toThrow(ValidationError);
    expect(() => validateMemoryNode(data)).toThrow('source');
  });

  test('MemoryNode without confidence throws', () => {
    const data = { ...validMemoryNode(), confidence: undefined };
    expect(() => validateMemoryNode(data)).toThrow(ValidationError);
    expect(() => validateMemoryNode(data)).toThrow('confidence');
  });

  test('MemoryNode with confidence > 1 throws', () => {
    const data = { ...validMemoryNode(), confidence: 1.5 };
    expect(() => validateMemoryNode(data)).toThrow(ValidationError);
    expect(() => validateMemoryNode(data)).toThrow(/between 0 and 1/);
  });

  test('MemoryNode with confidence < 0 throws', () => {
    const data = { ...validMemoryNode(), confidence: -0.1 };
    expect(() => validateMemoryNode(data)).toThrow(ValidationError);
    expect(() => validateMemoryNode(data)).toThrow(/between 0 and 1/);
  });

  test('MemoryNode without consent throws', () => {
    const data = { ...validMemoryNode(), consent: undefined };
    expect(() => validateMemoryNode(data)).toThrow(ValidationError);
    expect(() => validateMemoryNode(data)).toThrow('consent');
  });

  test('MemoryNode with invalid type throws', () => {
    const data = { ...validMemoryNode(), type: 'deal' };
    expect(() => validateMemoryNode(data)).toThrow(ValidationError);
    expect(() => validateMemoryNode(data)).toThrow(/must be one of/);
  });

  test('MemoryNode with empty slug throws', () => {
    const data = { ...validMemoryNode(), slug: '' };
    expect(() => validateMemoryNode(data)).toThrow(ValidationError);
    expect(() => validateMemoryNode(data)).toThrow('non-empty');
  });

  test('MemoryNode handles all valid types', () => {
    for (const t of ['person', 'company', 'project', 'concept', 'meeting'] as const) {
      const data = { ...validMemoryNode(), type: t };
      const result = validateMemoryNode(data);
      expect(result.type).toBe(t);
    }
  });
});

describe('validateRelation', () => {
  test('valid Relation passes', () => {
    const result = validateRelation(validRelation());
    expect(result.from_slug).toBe('anna-ExampleCorp');
    expect(result.to_slug).toBe('ExampleCorp');
    expect(result.relation_type).toBe('works_at');
    expect(result.confidence).toBe(0.9);
  });

  test('Relation with empty from_slug throws', () => {
    const data = { ...validRelation(), from_slug: '' };
    expect(() => validateRelation(data)).toThrow(ValidationError);
    expect(() => validateRelation(data)).toThrow('non-empty');
  });

  test('Relation with empty to_slug throws', () => {
    const data = { ...validRelation(), to_slug: '' };
    expect(() => validateRelation(data)).toThrow(ValidationError);
  });

  test('Relation with confidence > 1 throws', () => {
    const data = { ...validRelation(), confidence: 1.5 };
    expect(() => validateRelation(data)).toThrow(ValidationError);
    expect(() => validateRelation(data)).toThrow(/between 0 and 1/);
  });

  test('Relation with missing confidence throws', () => {
    const data = { ...validRelation(), confidence: undefined };
    expect(() => validateRelation(data)).toThrow(ValidationError);
    expect(() => validateRelation(data)).toThrow('confidence');
  });

  test('Relation without source throws', () => {
    const data = { ...validRelation(), source: undefined };
    expect(() => validateRelation(data)).toThrow(ValidationError);
    expect(() => validateRelation(data)).toThrow('source');
  });
});

describe('validateVoiceSession', () => {
  test('valid VoiceSession with all fields passes', () => {
    const result = validateVoiceSession(validVoiceSession());
    expect(result.id).toBe('voice-001');
    expect(result.transcript).toBe('Anna mentioned the new funding round.');
    expect(result.consent).toBe(true);
    expect(result.confidence).toBe(0.75);
    expect(result.duration_ms).toBe(45000);
    expect(result.page_slug).toBe('meetings/2026-04-10-funding');
  });

  test('VoiceSession with consent=false is valid', () => {
    const data = { ...validVoiceSession(), consent: false };
    const result = validateVoiceSession(data);
    expect(result.consent).toBe(false);
  });

  test('VoiceSession without transcript throws', () => {
    const data = { ...validVoiceSession(), transcript: undefined };
    expect(() => validateVoiceSession(data)).toThrow(ValidationError);
    expect(() => validateVoiceSession(data)).toThrow('transcript');
  });

  test('VoiceSession without source throws', () => {
    const data = { ...validVoiceSession(), source: undefined };
    expect(() => validateVoiceSession(data)).toThrow(ValidationError);
    expect(() => validateVoiceSession(data)).toThrow('source');
  });

  test('VoiceSession without confidence throws', () => {
    const data = { ...validVoiceSession(), confidence: undefined };
    expect(() => validateVoiceSession(data)).toThrow(ValidationError);
    expect(() => validateVoiceSession(data)).toThrow('confidence');
  });

  test('VoiceSession with page_slug undefined is valid', () => {
    const data = { ...validVoiceSession(), page_slug: undefined };
    const result = validateVoiceSession(data);
    expect(result.page_slug).toBeUndefined();
  });

  test('VoiceSession with negative duration_ms throws', () => {
    const data = { ...validVoiceSession(), duration_ms: -100 };
    expect(() => validateVoiceSession(data)).toThrow(ValidationError);
  });
});

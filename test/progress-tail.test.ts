/**
 * progress-tail tests — parse --progress-json events out of mixed stderr.
 */

import { describe, test, expect } from 'bun:test';
import { parseProgressEvents, eventsByPhase, verifyExpectedPhases } from '../src/core/claw-test/progress-tail.ts';

describe('parseProgressEvents', () => {
  test('extracts JSON event lines from mixed stderr', () => {
    const stderr = [
      'starting up',
      '{"phase":"import.files","event":"start"}',
      'warning: deprecated flag X',
      '{"phase":"import.files","event":"tick","done":3,"total":10}',
      'random text',
      '{"phase":"import.files","event":"finish"}',
    ].join('\n');
    const events = parseProgressEvents(stderr);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.event)).toEqual(['start', 'tick', 'finish']);
  });

  test('ignores malformed JSON lines silently', () => {
    const stderr = [
      '{"phase":"a","event":"start"}',
      '{"phase":',                       // truncated JSON
      'not json at all',
      '{"phase":"b","event":"start"}',
    ].join('\n');
    const events = parseProgressEvents(stderr);
    expect(events).toHaveLength(2);
  });

  test('ignores objects without phase field', () => {
    const stderr = [
      '{"phase":"a","event":"start"}',
      '{"foo":"bar"}',
      '{"phase":"b","event":"start"}',
    ].join('\n');
    const events = parseProgressEvents(stderr);
    expect(events.map(e => e.phase)).toEqual(['a', 'b']);
  });
});

describe('eventsByPhase', () => {
  test('groups by phase name', () => {
    const events = [
      { phase: 'import.files', event: 'start' },
      { phase: 'import.files', event: 'finish' },
      { phase: 'extract.links_fs', event: 'start' },
    ];
    const grouped = eventsByPhase(events);
    expect(grouped.get('import.files')).toHaveLength(2);
    expect(grouped.get('extract.links_fs')).toHaveLength(1);
  });
});

describe('verifyExpectedPhases', () => {
  test('returns empty when all expected phases present', () => {
    const events = [
      { phase: 'import.files' },
      { phase: 'extract.links_fs' },
      { phase: 'doctor.db_checks' },
    ];
    const missing = verifyExpectedPhases(events, ['import.files', 'doctor.db_checks']);
    expect(missing).toEqual([]);
  });

  test('returns missing phase names when some are absent', () => {
    const events = [
      { phase: 'import.files' },
    ];
    const missing = verifyExpectedPhases(events, ['import.files', 'extract.links_fs', 'doctor.db_checks']);
    expect(missing).toEqual(['extract.links_fs', 'doctor.db_checks']);
  });

  test('returns full expected list when no events at all', () => {
    const missing = verifyExpectedPhases([], ['a', 'b']);
    expect(missing).toEqual(['a', 'b']);
  });
});

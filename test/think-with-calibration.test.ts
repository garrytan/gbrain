/**
 * v0.36.0.0 (T8 / E1, D22) — think --with-calibration tests.
 *
 * Hermetic. Tests the prompt-building layer (no runThink invocation) +
 * pure structural shape of the user message.
 *
 * Tests cover:
 *  - D22 placement: calibration block sits AFTER retrieval, BEFORE question
 *  - default path (no calibration): existing v0.28 shape unchanged
 *    (regression R1)
 *  - system prompt gains anti-bias rules only when withCalibration=true
 *  - calibration block formatting: holder, patterns, bias tags, Brier
 *  - empty pattern/tag fields don't crash the builder
 */

import { describe, test, expect } from 'bun:test';
import {
  buildThinkUserMessage,
  buildThinkSystemPrompt,
  buildCalibrationBlock,
} from '../src/core/think/prompt.ts';

describe('buildThinkSystemPrompt — anti-bias rewrite rules (E1)', () => {
  test('withCalibration:false omits the anti-bias section (R1 regression guard)', () => {
    const out = buildThinkSystemPrompt({ withCalibration: false });
    expect(out).not.toContain('Calibration-aware mode');
    expect(out).not.toContain('COUNTER-PRIOR');
  });

  test('withCalibration omitted entirely → same as false (R1)', () => {
    const out = buildThinkSystemPrompt({});
    expect(out).not.toContain('Calibration-aware mode');
  });

  test('withCalibration:true adds anti-bias rules including PRIOR + COUNTER-PRIOR + bias-tag reference', () => {
    const out = buildThinkSystemPrompt({ withCalibration: true });
    expect(out).toContain('Calibration-aware mode');
    expect(out).toContain('PRIOR');
    expect(out).toContain('COUNTER-PRIOR');
    expect(out).toContain('over-confident-geography'); // example from the rule text
    expect(out).toContain('Calibration');
  });

  test('withCalibration:true preserves existing rules (Hard rules section)', () => {
    const out = buildThinkSystemPrompt({ withCalibration: true });
    expect(out).toContain('Hard rules:');
    expect(out).toContain('Cite EVERY substantive claim');
  });
});

describe('buildCalibrationBlock', () => {
  test('happy path emits holder + patterns + tags + brier', () => {
    const out = buildCalibrationBlock({
      holder: 'garry',
      patternStatements: [
        'You called early-stage tactics well — 8 of 10 held up.',
        'Geography is your blind spot — 4 of 6 missed.',
      ],
      activeBiasTags: ['over-confident-geography', 'late-on-macro-tech'],
      brier: 0.21,
    });
    expect(out).toContain('<calibration holder="garry">');
    expect(out).toContain('Brier 0.210');
    expect(out).toContain('Active patterns:');
    expect(out).toContain('- You called early-stage tactics well');
    expect(out).toContain('Active bias tags: over-confident-geography, late-on-macro-tech');
    expect(out).toContain('</calibration>');
  });

  test('null brier is omitted from the block (not "Brier null")', () => {
    const out = buildCalibrationBlock({
      holder: 'garry',
      patternStatements: ['x'],
      activeBiasTags: ['y-z'],
      brier: null,
    });
    expect(out).not.toContain('Brier null');
    expect(out).not.toContain('Brier NaN');
  });

  test('empty patterns + empty tags still produces well-formed block', () => {
    const out = buildCalibrationBlock({
      holder: 'garry',
      patternStatements: [],
      activeBiasTags: [],
    });
    expect(out).toContain('<calibration holder="garry">');
    expect(out).toContain('</calibration>');
    expect(out).not.toContain('Active patterns:');
    expect(out).not.toContain('Active bias tags:');
  });
});

describe('buildThinkUserMessage — D22 placement (E1)', () => {
  test('without calibration: question first, then retrieval, then instruction (regression R1)', () => {
    const out = buildThinkUserMessage({
      question: 'What do we know about acme-example?',
      pagesBlock: 'page block',
      takesBlock: 'take block',
    });
    const qIdx = out.indexOf('Question:');
    const pagesIdx = out.indexOf('<pages>');
    const takesIdx = out.indexOf('<takes>');
    const instructionIdx = out.indexOf('Respond with a single JSON object');

    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(pagesIdx).toBeGreaterThan(qIdx); // question BEFORE retrieval (existing shape)
    expect(takesIdx).toBeGreaterThan(pagesIdx);
    expect(instructionIdx).toBeGreaterThan(takesIdx);
    expect(out).not.toContain('<calibration');
  });

  test('with calibration: retrieval → calibration → question → instruction (D22 placement)', () => {
    const out = buildThinkUserMessage({
      question: 'Should we hire fast in NY?',
      pagesBlock: 'page block',
      takesBlock: 'take block',
      calibration: {
        holder: 'garry',
        patternStatements: ['Geography is your blind spot — 4 of 6 missed.'],
        activeBiasTags: ['over-confident-geography'],
        brier: 0.31,
      },
    });

    const pagesIdx = out.indexOf('<pages>');
    const takesIdx = out.indexOf('<takes>');
    const calIdx = out.indexOf('<calibration');
    const qIdx = out.indexOf('Question:');
    const instructionIdx = out.indexOf('Respond with a single JSON object');

    // D22: retrieval BEFORE calibration BEFORE question BEFORE instruction.
    expect(pagesIdx).toBeGreaterThan(-1);
    expect(takesIdx).toBeGreaterThan(pagesIdx);
    expect(calIdx).toBeGreaterThan(takesIdx);
    expect(qIdx).toBeGreaterThan(calIdx);
    expect(instructionIdx).toBeGreaterThan(qIdx);
  });

  test('with calibration + graph: retrieval (including graph) before calibration', () => {
    const out = buildThinkUserMessage({
      question: 'q',
      pagesBlock: 'p',
      takesBlock: 't',
      graphBlock: '<anchor>acme-example</anchor>\nReachable: x, y',
      calibration: {
        holder: 'garry',
        patternStatements: ['pattern'],
        activeBiasTags: ['tag-name'],
        brier: 0.2,
      },
    });
    const graphIdx = out.indexOf('<graph>');
    const calIdx = out.indexOf('<calibration');
    expect(graphIdx).toBeGreaterThan(-1);
    expect(calIdx).toBeGreaterThan(graphIdx);
  });

  test('empty retrieval blocks render placeholders without breaking shape', () => {
    const out = buildThinkUserMessage({
      question: 'q',
      pagesBlock: '',
      takesBlock: '',
      calibration: {
        holder: 'garry',
        patternStatements: ['p'],
        activeBiasTags: [],
      },
    });
    expect(out).toContain('(no page hits)');
    expect(out).toContain('(no take hits)');
    expect(out).toContain('<calibration');
  });
});

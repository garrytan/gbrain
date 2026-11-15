/**
 * facts_undated_lines doctor check (GST-2731): a facts page (type: facts) with fact lines that carry no date is
 * named with its line numbers, read-only, with a fix that names the page.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { factsUndatedLines, undatedFactLines } from '../src/commands/doctor/checks/facts-pages.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

describe('facts_undated_lines doctor check', () => {
  test('undated list lines are found by line number', () => {
    expect(undatedFactLines('Intro text without a date.\n\n- 2026-01-01: 12 customers. Source: billing.\n- 15 customers now\n* 3. two founders\n1. 2026-02-02: dated\n')).toEqual([4, 5]);
  });

  test('a facts page whose lines all carry a date is ok, and the check reads as brain health', async () => {
    await engine.putPage('company/facts', { type: 'facts', title: 'Company facts', compiled_truth: 'Numbers agents may quote.\n\n- 2026-01-01: 12 paying customers. Source: billing export.\n' });
    const check = await factsUndatedLines(engine);
    expect(check.status).toBe('ok');
    expect(categorizeCheck('facts_undated_lines')).toBe('brain');
  });

  test('a facts page with an undated line is a warn naming the page and the line, never its text', async () => {
    await engine.putPage('me/facts', { type: 'facts', title: 'Facts about me', compiled_truth: 'True things about me.\n\n- 2026-01-01: I live in example-city.\n- I like tea\n' });
    await engine.putPage('notes/todo', { type: 'note', title: 'Todo', compiled_truth: '- buy milk\n' });
    const before = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
    const check = await factsUndatedLines(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('default:me/facts (line 4)');
    expect(check.message).not.toContain('I like tea');
    expect(check.message).not.toContain('notes/todo');
    expect((check.details as any).pages).toEqual([{ source_id: 'default', slug: 'me/facts', lines: [4] }]);
    expect((check.fix as any).argv).toEqual(['gbrain', 'get', 'me/facts', '--source', 'default']);
    expect((check.fix as any).ask_user).toBe(true);
    expect((check.fix as any).user_message).toContain('me/facts');
    expect((check.fix as any).verify.argv).toEqual(['gbrain', 'doctor', '--only', 'facts_undated_lines', '--json']);
    expect(await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages')).toEqual(before);
  });
});

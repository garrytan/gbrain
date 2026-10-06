import { describe, expect, test } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import {
  CLI_WRITE_INFERENCE,
  OP_WRITE_INFERENCE,
  WRITE_INFERENCE_CLASSES,
  writeInferenceOf,
} from '../src/core/ops/write-inference.ts';

describe('write-inference classes', () => {
  test('every map entry names an existing mutating op with a known class', () => {
    for (const [name, cls] of Object.entries(OP_WRITE_INFERENCE)) {
      expect(WRITE_INFERENCE_CLASSES).toContain(cls);
      expect(operationsByName[name]).toBeDefined();
      expect(operationsByName[name]!.mutating).toBe(true);
    }
    for (const cls of Object.values(CLI_WRITE_INFERENCE)) expect(WRITE_INFERENCE_CLASSES).toContain(cls);
  });

  test('an unclassified op resolves to the strictest class; inline wins over the map', () => {
    expect(writeInferenceOf({ name: 'some_future_write' })).toBe('none');
    expect(writeInferenceOf({ name: 'think' })).toBe('explicit_llm');
    expect(writeInferenceOf({ name: 'think', writeInference: 'none' })).toBe('none');
  });

  test('inline classes on ops are valid', () => {
    for (const op of operations) {
      if (op.writeInference !== undefined) expect(WRITE_INFERENCE_CLASSES).toContain(op.writeInference);
    }
  });

  test('the memory write verbs keep their promises', () => {
    expect(writeInferenceOf(operationsByName.remember!)).toBe('embedding');
    expect(writeInferenceOf(operationsByName.forget!)).toBe('none');
    expect(writeInferenceOf(operationsByName.put_page!)).toBe('async_derived');
  });
});

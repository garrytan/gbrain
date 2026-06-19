/**
 * C++ nested method emission + declarator-name extraction.
 *
 * Pre-existing gap: `cpp` ships in TOP_LEVEL_TYPES (top-level functions/classes
 * chunk) but was absent from NESTED_EMIT_CONFIG, and extractSymbolName did not
 * descend the C/C++ `declarator` chain — so C++ class methods were neither
 * emitted as their own chunks nor named. These are general-purpose chunker
 * improvements (the MQL layer reuses the same tree-sitter-cpp shapes).
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeText } from '../../src/core/chunkers/code.ts';

const CALCULATOR_CPP = `class Calculator
{
public:
   int Add(int a, int b)
   {
      return a + b;
   }

   int Multiply(int a, int b)
   {
      return a * b;
   }
};
`;

describe('C++ — class method definitions', () => {
  test('emits each class method as its own chunk scoped to the class', async () => {
    const chunks = await chunkCodeText(CALCULATOR_CPP, 'calc.cpp', { chunkSizeTokens: 50 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.metadata.language).toBe('cpp');

    const add = chunks.find(c => c.metadata.symbolName === 'Add');
    expect(add).toBeDefined();
    expect(add!.metadata.parentSymbolPath).toEqual(['Calculator']);

    const mul = chunks.find(c => c.metadata.symbolName === 'Multiply');
    expect(mul).toBeDefined();
    expect(mul!.metadata.parentSymbolPath).toEqual(['Calculator']);
  });
});

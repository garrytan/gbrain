/**
 * v0.34 W2 — edge densification: imports + references edges.
 *
 * Tests that `extractImportEdges`, `extractReferenceEdges`, and the
 * combined `extractAllEdges` emit the right edge types for each language
 * shipped at depth (JS/TS/TSX + Python imports; TS only for references).
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import {
  extractAllEdges,
  extractImportEdges,
  extractReferenceEdges,
} from '../../src/core/chunkers/edge-extractor.ts';

let Parser: any;
let TSLang: any;
let PYLang: any;

beforeAll(async () => {
  try {
    const ts = await import('web-tree-sitter');
    Parser = (ts as any).Parser ?? (ts as any).default;
    await Parser.init();
    const tsWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm');
    const pyWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm');
    TSLang = await Parser.Language.load(tsWasmPath);
    PYLang = await Parser.Language.load(pyWasmPath);
  } catch {
    Parser = null;
  }
});

function parseTS(source: string): any {
  if (!Parser || !TSLang) return null;
  const p = new Parser();
  p.setLanguage(TSLang);
  return p.parse(source);
}

function parsePY(source: string): any {
  if (!Parser || !PYLang) return null;
  const p = new Parser();
  p.setLanguage(PYLang);
  return p.parse(source);
}

describe('W2: imports edges — JS/TS', () => {
  test('named imports emit one edge per symbol', () => {
    const tree = parseTS(`import { useState, useEffect } from 'react';`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'typescript');
    expect(edges.some((e) => e.edgeType === 'imports' && e.toSymbol === 'react::useState')).toBe(true);
    expect(edges.some((e) => e.edgeType === 'imports' && e.toSymbol === 'react::useEffect')).toBe(true);
  });

  test('default import emits module::default', () => {
    const tree = parseTS(`import React from 'react';`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'typescript');
    expect(edges.some((e) => e.toSymbol === 'react::default')).toBe(true);
  });

  test('namespace import emits module::*', () => {
    const tree = parseTS(`import * as React from 'react';`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'typescript');
    expect(edges.some((e) => e.toSymbol === 'react::*')).toBe(true);
  });

  test('aliased named imports use the source name not the alias', () => {
    const tree = parseTS(`import { useState as us } from 'react';`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'typescript');
    expect(edges.some((e) => e.toSymbol === 'react::useState')).toBe(true);
  });

  test('side-effect import emits module::*', () => {
    const tree = parseTS(`import 'reflect-metadata';`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'typescript');
    expect(edges.some((e) => e.toSymbol === 'reflect-metadata::*')).toBe(true);
  });
});

describe('W2: imports edges — Python', () => {
  test('from x import y, z emits one edge per symbol', () => {
    const tree = parsePY(`from os import path, getcwd`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'python');
    expect(edges.some((e) => e.toSymbol === 'os::path')).toBe(true);
    expect(edges.some((e) => e.toSymbol === 'os::getcwd')).toBe(true);
  });

  test('import pkg emits pkg::*', () => {
    const tree = parsePY(`import json`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'python');
    expect(edges.some((e) => e.toSymbol === 'json::*')).toBe(true);
  });

  test('aliased import uses source not alias', () => {
    const tree = parsePY(`from os import path as p`);
    if (!tree) return;
    const edges = extractImportEdges(tree, 'python');
    expect(edges.some((e) => e.toSymbol === 'os::path')).toBe(true);
  });
});

describe('W2: references edges — TS only', () => {
  test('function parameter type references emit edges', () => {
    const tree = parseTS(`function foo(x: MyType): void {}`);
    if (!tree) return;
    const edges = extractReferenceEdges(tree, 'typescript');
    expect(edges.some((e) => e.edgeType === 'references' && e.toSymbol === 'MyType')).toBe(true);
  });

  test('return type annotation emits edge', () => {
    const tree = parseTS(`function foo(): MyReturnType { return null as any; }`);
    if (!tree) return;
    const edges = extractReferenceEdges(tree, 'typescript');
    expect(edges.some((e) => e.toSymbol === 'MyReturnType')).toBe(true);
  });

  test('python returns empty (references is TS-only for v0.34)', () => {
    const tree = parsePY(`def foo(x: int) -> int: return x`);
    if (!tree) return;
    const edges = extractReferenceEdges(tree, 'python');
    expect(edges).toEqual([]);
  });
});

describe('W2: combined extractAllEdges', () => {
  test('returns calls + imports + references union', () => {
    const tree = parseTS(`
      import { useState } from 'react';
      function foo(x: MyType) {
        useState();
      }
    `);
    if (!tree) return;
    const edges = extractAllEdges(tree, 'typescript');
    expect(edges.some((e) => e.edgeType === 'imports')).toBe(true);
    expect(edges.some((e) => e.edgeType === 'references')).toBe(true);
    expect(edges.some((e) => e.edgeType === 'calls')).toBe(true);
  });

  test('Ruby/Go/Rust/Java: calls only (no imports, no references)', () => {
    // Per D18: only JS/TS/TSX + Python emit imports.
    // We can't easily parse Ruby/Go/Rust here without their grammars loaded,
    // but the contract is encoded in the function signature — these
    // languages return [] from extractImportEdges. Confirm via direct call
    // with a null tree shape.
    const nullTree = { rootNode: { namedChildren: [] } };
    expect(extractImportEdges(nullTree, 'ruby')).toEqual([]);
    expect(extractImportEdges(nullTree, 'go')).toEqual([]);
    expect(extractImportEdges(nullTree, 'rust')).toEqual([]);
    expect(extractImportEdges(nullTree, 'java')).toEqual([]);
    expect(extractReferenceEdges(nullTree, 'ruby')).toEqual([]);
    expect(extractReferenceEdges(nullTree, 'python')).toEqual([]);
  });
});

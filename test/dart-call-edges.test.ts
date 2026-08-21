/**
 * Dart call-edge extraction.
 *
 * tree-sitter-dart has no call node, so CALL_CONFIG — which names a call node
 * type and reads the callee from a field or the first named child — cannot
 * describe it. An invocation is a flat run of siblings with the argument list
 * to the RIGHT of the name, so the callee is found positionally. These cases
 * are the shapes that rule has to survive; each one was read off the real
 * parse tree rather than guessed.
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeTextFull } from '../src/core/chunkers/code.ts';

async function callees(body: string): Promise<string[]> {
  const { edges } = await chunkCodeTextFull(`void f() async {\n  ${body}\n}\n`, 'x.dart', {});
  return edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol).sort();
}

describe('Dart call edges', () => {
  test.each([
    ['bare call',            'bare(1);',                 ['bare']],
    ['method call',          'obj.method(2);',           ['method']],
    ['null-aware call',      'obj?.method(3);',          ['method']],
    ['constructor',          'Foo();',                   ['Foo']],
    ['named constructor',    'Foo.named(1);',            ['named']],
    ['explicit new',         'new Widget(2);',           ['Widget']],
    ['generic call',         'cast<int>(x);',            ['cast']],
    ['awaited call',         'await fetchIt();',         ['fetchIt']],
    // Both halves of a chain, exactly once each — the shape where a
    // left-walk that does not stop at the previous argument list would
    // attribute `c()` to `b` as well.
    ['chained calls',        'a.b().c();',               ['b', 'c']],
    // Cascades put argument_part beside cascade_selector instead of inside
    // a selector, so the general rule never fires and they need their own.
    ['cascade',              'obj..first()..second();',  ['first', 'second']],
    ['nested call argument', 'outer(inner(1));',         ['inner', 'outer']],
  ])('%s', async (_label, src, expected) => {
    expect(await callees(src as string)).toEqual(expected as string[]);
  });

  test('invoking a call RESULT emits the named call once, not twice', async () => {
    // `a()()` is one call to `a` plus a call on its anonymous result. Reading
    // the nearest name to the left for that second invocation yields ['a','a']
    // — one definition, two edges. Found by mutation: the first version of the
    // left-walk did exactly that and every other case still passed.
    expect(await callees('a()();')).toEqual(['a']);
    expect(await callees('make()(1);')).toEqual(['make']);
    expect(await callees('list[0]();')).toEqual([]);
  });

  test('a non-call selector emits nothing', async () => {
    // Property access and indexing carry no argument_part. Without this the
    // suite would pass on an extractor that emits an edge per selector.
    expect(await callees('final x = obj.field;')).toEqual([]);
    expect(await callees('final y = list[0];')).toEqual([]);
  });

  test('call edges land on real Flutter source', async () => {
    const src = `import 'package:flutter/material.dart';

Widget build(BuildContext context) {
  final style = styleFor(context);
  return Padding(
    padding: EdgeInsets.all(measureLabel(style)),
    child: Text(labelFor(style)),
  );
}
`;
    const got = await callees(src.replace(/^/, ''));
    for (const want of ['styleFor', 'measureLabel', 'labelFor', 'Text', 'Padding']) {
      expect(got).toContain(want);
    }
  });
});

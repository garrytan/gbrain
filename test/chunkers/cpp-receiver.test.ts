/**
 * C++ receiver-type resolution at edge-extraction time (cpp-general; the MQL
 * tag reuses these same tree-sitter-cpp shapes).
 *
 * An intra-class call with an IMPLICIT receiver — a bare `Calculate(x)` inside
 * a method of class C, the C++/MQL idiom — resolves to the enclosing class:
 * `C.Calculate`. Two classes defining a same-named method therefore key on
 * DISTINCT qualified callees instead of the conflated bare token.
 *
 * The honest precision boundary (exactly-one-sibling rule):
 *   - exactly 1 inline sibling method named `m` in the class → emit `C.m`
 *   - 0 siblings (a genuine global/library call like `Helper`) → stay BARE
 *   - >1 (overload) → stay BARE (no confident false edge)
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeTextFull } from '../../src/core/chunkers/code.ts';

const TWO_CLASSES_HPP = `class CAlpha {
public:
  double Calculate(double x) { return Helper(x); }
  double Run(double x) { return Calculate(x); }
};

class CBeta {
public:
  double Calculate(double x) { return x + 1.0; }
  double Start(double x) { return Calculate(x); }
};
`;

describe('C++ — implicit-this receiver resolution', () => {
  test('intra-class calls resolve to the enclosing class; globals stay bare', async () => {
    const { edges } = await chunkCodeTextFull(TWO_CLASSES_HPP, 'src/two.hpp', {
      chunkSizeTokens: 50,
    });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);

    // Sibling calls qualify to their OWN class — no conflation.
    expect(callees).toContain('CAlpha.Calculate');
    expect(callees).toContain('CBeta.Calculate');

    // A genuine global/library call has no sibling method → stays bare.
    expect(callees).toContain('Helper');
    expect(callees).not.toContain('CAlpha.Helper');
  });

  test('an overloaded sibling stays bare (no confident false edge)', async () => {
    const OVERLOADED_HPP = `class CGamma {
public:
  double Scale(double x) { return x; }
  double Scale(double x, double y) { return x + y; }
  double Run(double x) { return Scale(x); }
};
`;
    const { edges } = await chunkCodeTextFull(OVERLOADED_HPP, 'src/gamma.hpp', {
      chunkSizeTokens: 50,
    });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    // Two methods named Scale → ambiguous → the call stays bare, never a
    // confident pick of one overload.
    expect(callees).toContain('Scale');
    expect(callees).not.toContain('CGamma.Scale');
  });

  // An OUT-OF-LINE method definition (`void CFoo::Bar(){...}` outside the class
  // body) has no ENCLOSING class_specifier for the call site to walk up to — the
  // walk reaches translation_unit. We recover the class from the definition's
  // `qualified_identifier` scope (`CFoo::Bar` → `CFoo`) and apply the same
  // exactly-one-declaration rule, so a bare sibling call resolves to `CFoo.Baz`.
  test('an out-of-line method definition resolves sibling calls to the class', async () => {
    const OUT_OF_LINE_HPP = `class CFoo {
public:
  void Bar();
  void Baz();
};

void CFoo::Bar() {
  Baz();
}

void CFoo::Baz() {
}
`;
    const { edges } = await chunkCodeTextFull(OUT_OF_LINE_HPP, 'src/foo.hpp', {
      chunkSizeTokens: 50,
    });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    // The class is declared in-file: exactly one declaration of `Baz` (the
    // prototype) → the out-of-line sibling call qualifies to `CFoo.Baz`.
    expect(callees).toContain('CFoo.Baz');
    expect(callees).not.toContain('Baz');
  });

  test('an overloaded sibling stays bare in an out-of-line definition', async () => {
    const OUT_OF_LINE_OVERLOAD_HPP = `class CFoo {
public:
  void Run();
  double Scale(double x);
  double Scale(double x, double y);
};

void CFoo::Run() {
  Scale(1.0);
}

double CFoo::Scale(double x) { return x; }
double CFoo::Scale(double x, double y) { return x + y; }
`;
    const { edges } = await chunkCodeTextFull(OUT_OF_LINE_OVERLOAD_HPP, 'src/foo.hpp', {
      chunkSizeTokens: 50,
    });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    // Two declarations of `Scale` in the class body → ambiguous → stay bare.
    expect(callees).toContain('Scale');
    expect(callees).not.toContain('CFoo.Scale');
  });

  test('a library call in an out-of-line definition stays bare', async () => {
    const OUT_OF_LINE_LIB_HPP = `class CFoo {
public:
  void Tick();
};

void CFoo::Tick() {
  TimeCurrent();
}
`;
    const { edges } = await chunkCodeTextFull(OUT_OF_LINE_LIB_HPP, 'src/foo.hpp', {
      chunkSizeTokens: 50,
    });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    // `TimeCurrent` has no declaration in the class → not a sibling → stays bare.
    expect(callees).toContain('TimeCurrent');
    expect(callees).not.toContain('CFoo.TimeCurrent');
  });

  // When the class is declared in ANOTHER file (the .cpp-implements-a-.h shape),
  // there is no class_specifier in this translation unit. Fall back to counting
  // out-of-line definitions with the same scope; exactly one → resolve.
  test('out-of-line defs resolve via scope when the class is declared elsewhere', async () => {
    const IMPL_ONLY_CPP = `void CExternal::DoWork() {
  Helper();
}

void CExternal::Helper() {
}
`;
    const { edges } = await chunkCodeTextFull(IMPL_ONLY_CPP, 'src/external.cpp', {
      chunkSizeTokens: 50,
    });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    // One out-of-line definition of `Helper` with scope `CExternal` → resolve.
    expect(callees).toContain('CExternal.Helper');
    expect(callees).not.toContain('Helper');
  });
});

describe('C++ — member-field / object receiver resolution', () => {
  // `m_x.Method()` and `obj.Method()` resolve to the RECEIVER's declared type,
  // not the enclosing class. The type is explicit (`CWorker m_worker;`), so the
  // class attribution is certain — no sibling-count guesswork. This is the
  // dominant call shape in real MQL (member objects + accessor methods).
  test('a member-field call resolves to the field type, not the enclosing class', async () => {
    const HPP = `class CHolder {
private:
  CWorker m_worker;
  int     m_count;
public:
  void Run() {
    m_worker.DoWork();
    m_count = m_count + 1;
  }
};
`;
    const { edges } = await chunkCodeTextFull(HPP, 'src/holder.hpp', { chunkSizeTokens: 50 });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    expect(callees).toContain('CWorker.DoWork');
    // NOT attributed to the enclosing class — it's the field's type.
    expect(callees).not.toContain('CHolder.DoWork');
    expect(callees).not.toContain('DoWork');
  });

  test('a local-object call resolves to the local variable type', async () => {
    const HPP = `class CHolder {
public:
  void Run() {
    CHelper h;
    h.Assist();
  }
};
`;
    const { edges } = await chunkCodeTextFull(HPP, 'src/holder.hpp', { chunkSizeTokens: 50 });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    expect(callees).toContain('CHelper.Assist');
    expect(callees).not.toContain('Assist');
  });

  test('a member call inside an OUT-OF-LINE method resolves via the class fields', async () => {
    const HPP = `class CHolder {
private:
  CWorker m_worker;
public:
  void Run();
};

void CHolder::Run() {
  m_worker.DoWork();
}
`;
    const { edges } = await chunkCodeTextFull(HPP, 'src/holder.hpp', { chunkSizeTokens: 50 });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    expect(callees).toContain('CWorker.DoWork');
  });

  test('a call on an undeclared / unknown receiver stays bare', async () => {
    const HPP = `class CHolder {
public:
  void Run(Something& thing) {
    thing.Frobnicate();
  }
};
`;
    const { edges } = await chunkCodeTextFull(HPP, 'src/holder.hpp', { chunkSizeTokens: 50 });
    const callees = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    // `thing` has no in-scope declaration we can resolve → stay bare.
    expect(callees).toContain('Frobnicate');
    expect(callees).not.toContain('CHolder.Frobnicate');
  });
});

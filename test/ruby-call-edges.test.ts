/**
 * Ruby call-edge names.
 *
 * Ruby chunks are qualified `A::B#m` (instance) and `A::B.m` (singleton), so
 * a call edge resolves, and is found by `code_callers` / `code_blast`, only
 * when it carries the same name. Each case below is a call shape whose
 * receiver the syntax names; the negative cases are the shapes where the
 * file alone cannot prove the target, which keep their bare or written token.
 *
 * A zero-argument call written without parentheses (`helper`) parses as an
 * identifier, the same node a local variable reads as; the last block pins
 * Ruby's parse-time rule that tells them apart.
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeTextFull } from '../src/core/chunkers/code.ts';

/** The call edges of `src` with the nesting each relative constant carries for the resolver. */
async function nestings(src: string): Promise<Array<[string, string[] | undefined]>> {
  const { edges } = await chunkCodeTextFull(src, 'app/models/x.rb', {});
  return edges.filter(e => e.edgeType === 'calls').map(e => [e.toSymbol, e.rubyNesting] as [string, string[] | undefined])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** The call edges of `src`, sorted, as `toSymbol` plus a `~` marker for an untyped member call. */
async function callees(src: string): Promise<string[]> {
  const { edges } = await chunkCodeTextFull(src, 'app/models/x.rb', {});
  return edges.filter(e => e.edgeType === 'calls').map(e => `${e.toSymbol}${e.memberCall ? '~' : ''}`).sort();
}

/** `body` as the body of an instance method of Acme::Widget, which also defines `helper` and `self.build`. */
const inWidget = (body: string) => `module Acme
  class Widget
    def run
      ${body}
    end

    def helper; end

    def self.build; end
  end
end
`;

describe('Ruby call edges', () => {
  test.each([
    ['constant receiver',                 'Acme::Widget.build',     ['Acme::Widget.build']],
    ['absolute constant receiver',        '::Billing::Ledger.post', ['Billing::Ledger.post']],
    ['construction is a use of the class', 'Billing::Ledger.new(1)', ['Billing::Ledger']],
    ['method of a new instance',          'Billing::Ledger.new.post', ['Billing::Ledger', 'Billing::Ledger#post']],
    ['receiverless call, defined here',   'helper(1)',              ['Acme::Widget#helper']],
    ['self call, defined here',           'self.helper',            ['Acme::Widget#helper']],
    ['predicate and bang methods',        'Order.valid?; Order.save!', ['Order.save!', 'Order.valid?']],
    // Ruby's lexical lookup: `Widget` inside `module Acme` is Acme::Widget,
    // which this file defines.
    ['relative constant defined here',    'Widget.build',           ['Acme::Widget.build']],
  ])('%s', async (_label, body, expected) => {
    expect(await callees(inWidget(body as string))).toEqual(expected as string[]);
  });

  test('singleton context: `new(...).m`, `new` and a singleton helper qualify against the class', async () => {
    const src = `module Acme
  class Service
    def self.call(input)
      prepare(input)
      new(input).call
    end

    def self.prepare(input); end

    def call; end
  end
end
`;
    expect(await callees(src)).toEqual(['Acme::Service', 'Acme::Service#call', 'Acme::Service.prepare']);
  });

  test('chunk identity: `def self.m` is Class.m and `def m` is Class#m, so the two never collide', async () => {
    const { chunks } = await chunkCodeTextFull(`class Acme::Service
  def self.call(x) = new.call
  def call; end
end
`, 'app/services/service.rb', {});
    const names = chunks.map(c => c.metadata.symbolNameQualified).filter(n => n !== 'Acme::Service').sort();
    expect(names).toEqual(['Acme::Service#call', 'Acme::Service.call']);
  });

  test('a call the file cannot prove keeps its bare or written token', async () => {
    // `render` is not defined here (inherited or framework), `Client` is not
    // defined here (Ruby may find Acme::Client in another file or ::Client),
    // `@repo.save` has an untyped receiver.
    expect(await callees(inWidget('render :show; Client.fetch; @repo.save'))).toEqual(['Client.fetch', 'render', 'save~']);
  });

  test('an instance call does not resolve to a singleton method of the same name, and vice versa', async () => {
    const src = `module Acme
  class Widget
    def run
      build(1)
    end

    def self.make
      helper(1)
    end

    def helper(x); end

    def self.build(x); end
  end
end
`;
    expect(await callees(src)).toEqual(['build', 'helper']);
  });

  test('a compact `class A::B` does not put A in the lookup nesting', async () => {
    // Module.nesting inside `class Acme::Report` is [Acme::Report], so
    // `Client` is not looked up in Acme even though this file defines it.
    const src = `module Acme
  class Client; end
end

class Acme::Report
  def run
    Client.fetch
  end
end
`;
    expect(await callees(src)).toEqual(['Client.fetch']);
  });

  test('a block between a call and the class body leaves `self` unknown', async () => {
    // `included do ... end` and friends may run against another receiver.
    const src = `module Acme
  class Widget
    included do
      helper(1)
    end

    def self.helper(x); end
  end
end
`;
    expect(await callees(src)).toEqual(['helper', 'included']);
  });

  test('a relative constant the file does not define carries the nesting; a proven or absolute one does not', async () => {
    const src = `module Acme
  class Widget
    def run
      Client.fetch(1)
      Part.build(1)
      ::Billing::Ledger.post(1)
    end

    class Part
      def self.build(x); end
    end
  end
end
`;
    expect(await nestings(src)).toEqual([
      ['Acme::Widget::Part.build', undefined],
      ['Billing::Ledger.post', undefined],
      ['Client.fetch', ['Acme::Widget', 'Acme']],
    ]);
  });
});

/** `body` inside `def run(arg)` of Acme::Widget, which also defines `helper`, `arg` and `later` (instance) and `self.klass_only`. */
const parenless = (body: string) => `module Acme
  class Widget
    def run(arg)
      ${body}
    end

    def helper; end
    def arg; end
    def later; end
    def self.klass_only; end
  end
end
`;

describe('Ruby paren-less calls', () => {
  test.each([
    ['a defined method',                  'helper',                         ['Acme::Widget#helper']],
    ['inside a block',                    'attempt { helper }',             ['Acme::Widget#helper', 'attempt']],
    ['as a receiver',                     'helper.size',                    ['Acme::Widget#helper', 'size~']],
    // Ruby's rule is positional: a local exists only after its assignment.
    ['assigned after the reference',      'later; later = 1',               ['Acme::Widget#later']],
    // A local assigned inside one block is not visible after it.
    ['assigned only inside a block',      'each { helper = 1 }; helper',    ['Acme::Widget#helper', 'each']],
  ])('%s emits an edge', async (_label, body, expected) => {
    expect(await callees(parenless(body as string))).toEqual(expected as string[]);
  });

  test.each([
    ['an assigned local',                 'helper = 1; helper'],
    ['a method parameter',                'arg'],
    ['a block parameter',                 'each { |helper| helper }'],
    ['an operator-assigned local',        'helper ||= 1; helper'],
    ['a multiple-assignment local',       'helper, x = 1, 2; helper'],
    ['a rescue variable',                 'begin; rescue => helper; helper; end'],
    ['an unknown name',                   'unknown_thing'],
    // Blocks see the locals around them.
    ['a local read inside a block',       'helper = 1; each { helper }'],
    ['a pattern variable',                'case arg; in [helper]; helper; end'],
    // defined? tests for the method without calling it.
    ['the operand of defined?',           'defined?(helper)'],
    ['a singleton method, from an instance method', 'klass_only'],
  ])('%s emits no edge', async (_label, body) => {
    const edges = await callees(parenless(body as string));
    expect(edges.filter(e => e.startsWith('Acme::Widget#'))).toEqual([]);
  });
});


/** The calls edges of `src` with their resolver hand-off (`toSymbol`, inner scopes, written form). */
async function handoffs(src: string): Promise<Array<[string, string[] | undefined, string | undefined]>> {
  const { edges } = await chunkCodeTextFull(src, 'app/models/x.rb', {});
  return edges.filter(e => e.edgeType === 'calls').map(e => [e.toSymbol, e.rubyNesting, e.rubyWritten] as [string, string[] | undefined, string | undefined])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe('Ruby self context, setters and singleton bodies', () => {
  test('an assignment through a receiver calls the setter; an operator assignment calls both', async () => {
    const src = `module Acme
  class Thermostat
    def bump
      self.target = 72
      self.level += 1
      Thermostat.mode = 2
      self.lo, self.hi = 1, 2
    end

    def target=(v); end
    def lo=(v); end
    def hi=(v); end
    def level; end
    def level=(v); end
    def self.mode=(v); end
  end
end
`;
    expect(await callees(src)).toEqual(['Acme::Thermostat#hi=', 'Acme::Thermostat#level', 'Acme::Thermostat#level=', 'Acme::Thermostat#lo=', 'Acme::Thermostat#target=', 'Acme::Thermostat.mode=']);
  });

  test('a def inside a block in a module (Data.define do) does not take the module as self', async () => {
    const src = `module Billing
  LedgerReading = Data.define(:amount) do
    def self.from_record(record)
      new(amount: 1)
      helper(1)
    end
  end

  def self.helper(x); end
end
`;
    expect(await callees(src)).toEqual(['Data.define', 'helper', 'new']);
  });

  test('instance_eval rebinds self; class << OTHER and def OTHER.m are not this class', async () => {
    const src = `class Widget
  def run(obj)
    obj.instance_eval { helper(1) }
  end

  class << OTHER
    def m
      helper(2)
    end
  end

  def OTHER.z
    helper(3)
  end

  def helper(x); end
  def self.helper(x); end
end
`;
    expect(await callees(src)).toEqual(['helper', 'helper', 'helper', 'instance_eval~']);
  });

  test('class << self: its methods are singleton chunks and call each other as Class.m; its body is not a def', async () => {
    const src = `class Widget
  class << self
    attr_accessor :registry
    make(0)
    def build(x)
      make(1)
    end

    def make(x); end
  end
end
`;
    const { chunks } = await chunkCodeTextFull(src, 'app/models/widget.rb', {});
    expect(chunks.map(c => c.metadata.symbolNameQualified).filter(n => n !== 'Widget')).toEqual(['Widget.build', 'Widget.make']);
    // In the `class << self` body itself, self is the singleton class, not Widget.
    expect(await callees(src)).toEqual(['Widget.make', 'attr_accessor', 'make']);
  });

  test('a singleton method defined only on another object or in class << OTHER does not prove Class.m', async () => {
    const src = `class Widget
  def self.run
    z(1)
    m(1)
  end

  def OTHER.z(x); end

  class << OTHER
    def m(x); end
  end
end
`;
    expect(await callees(src)).toEqual(['m', 'z']);
  });

  test('a constant assigned in the class body is found by the lexical lookup', async () => {
    const src = `class Widget
  Limits = Struct.new(:max)
  def run
    Limits.new(1)
  end
end
`;
    expect(await callees(src)).toEqual(['Struct', 'Widget::Limits']);
  });

  test('a class named ::B inside module A is the top-level B', async () => {
    const src = `module A
  class ::B
    def run
      helper(1)
    end

    def helper(x); end
  end
end
`;
    expect(await callees(src)).toEqual(['B#helper']);
  });

  test('new without a receiver inside an instance method is not the class', async () => {
    expect(await callees(inWidget('new(1)'))).toEqual(['new']);
  });

  test('a constant this file proves only in an outer scope hands the inner scopes to the resolver', async () => {
    const src = `module Acme
  class Client; end
  class Widget
    def run
      Client.fetch(1)
    end
  end
end
`;
    expect(await handoffs(src)).toEqual([['Acme::Client.fetch', ['Acme::Widget'], 'Client']]);
  });

  test('backticks and %x() are calls to Kernel#`', async () => {
    expect(await callees(inWidget('`ls`; %x(pwd)'))).toEqual(['`', '`']);
  });
});

describe('Ruby parameter defaults and implicit block parameters', () => {
  test('nothing inside defined? is a call, receiver or method', async () => {
    expect(await callees(parenless('defined?(helper.size)'))).toEqual([]);
  });

  test('a parameter default is a call; only the parameter name is bound', async () => {
    const src = `class Widget
  def run(x = helper, timeout: limit)
    x
  end

  def helper; end
  def limit; end
end
`;
    expect(await callees(src)).toEqual(['Widget#helper', 'Widget#limit']);
  });

  test('it and _1 in a block without parameters are the implicit parameter; with parameters, it is a call', async () => {
    const src = `class Widget
  def run
    [1].map { it }
    [1].map { _1 }
    -> { it }
    [1].map { |y| it }
    ->(x) { it }
  end

  def it; end
  def _1; end
end
`;
    expect(await callees(src)).toEqual(['Widget#it', 'Widget#it', 'map~', 'map~', 'map~']);
  });
});


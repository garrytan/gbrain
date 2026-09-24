import { describe, expect, test } from 'bun:test';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';

const first = "{'source': 'microphone', 'attribution': 'me'}: hello";
const second = "{'source': 'speaker', 'name': 'alice-example', 'attribution': 'them'}: hi";

describe('speaker objects (#5364)', () => {
  test('parses the reported shape using the page date', () => {
    const result = parseConversation(`${first}\n${second}`, { fallbackDate: '2026-06-02' });
    expect(result.phase).toBe('regex_match');
    expect(result.matched_pattern_id).toBe('python-dict-utterance');
    expect(result.messages).toEqual([
      { speaker: 'me', timestamp: '2026-06-02T00:00:00Z', text: 'hello' },
      { speaker: 'alice-example', timestamp: '2026-06-02T00:00:00Z', text: 'hi' },
    ]);
  });

  const fields = ["'source': 'speaker'", "'attribution': 'them'", "'name': 'alice-example'"];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    test(`explicit name wins in key order ${order.join(',')}`, () => {
      const result = parseConversation(`{${order.map(i => fields[i]).join(', ')}}: hello`);
      expect(result.messages).toEqual([
        { speaker: 'alice-example', timestamp: '1970-01-01T00:00:00Z', text: 'hello' },
      ]);
    });
  }

  test('fallback attribution works in either key order with horizontal whitespace', () => {
    const result = parseConversation("{ 'attribution' : 'them', 'source' : 'speaker' }: hi");
    expect(result.messages.map(m => m.speaker)).toEqual(['them']);
  });

  test('finds a dedicated transcript section after summary prose', () => {
    const result = parseConversation(`# Meeting\n## Summary\nA short overview.\n## Transcript\n${first}\n${second}`);
    expect(result.messages.map(m => m.speaker)).toEqual(['me', 'alice-example']);
  });

  test('allows ordinary quoted summary prose before a dedicated transcript', () => {
    const result = parseConversation(`## Summary\nAlice's update was "ready" (after review).\n## Transcript\n${first}\n${second}`);
    expect(result.messages.map(m => m.speaker)).toEqual(['me', 'alice-example']);
  });

  test.each(["The founders' update is ready.", "Both participants' notes are ready.", "Alice's update is ready."])(
    'does not treat a prose apostrophe as a literal wrapper: %s', (summary) => {
      const result = parseConversation(`## Summary\n${summary}\n## Transcript\n${first}\n${second}`);
      expect(result.messages.map(m => m.speaker)).toEqual(['me', 'alice-example']);
    },
  );

  test.each(['Follow up next week.', 'Good job :)', 'Quoted note: "unfinished', 'An unfinished list ['])(
    'ends an explicit transcript without reclassifying its following notes: %s', (notes) => {
      const result = parseConversation(`## Transcript\n${first}\n${second}\n## Action Items\n${notes}`);
      expect(result.messages.map(m => [m.speaker, m.text])).toEqual([['me', 'hello'], ['alice-example', 'hi']]);
    },
  );

  test('ordinary summary punctuation does not hide a following transcript', () => {
    const result = parseConversation(`## Summary\nGood job :)\n## Transcript\n${first}\n${second}`);
    expect(result.messages.map(m => m.speaker)).toEqual(['me', 'alice-example']);
  });

  test('a wrapper in a following heading cannot open another transcript section', () => {
    const result = parseConversation(`## Transcript\n${first}\n${second}\n## Example {'quoted': '''\n## Transcript\n${first}\n${second}`);
    expect(result.phase).toBe('no_match');
    expect(result.messages).toEqual([]);
  });

  test('preserves running date headings without opening fenced speakers', () => {
    const result = parseConversation(`## 2026-06-02\n${first}\n\`\`\`python\n${second}\n\`\`\`\n## 2026-06-03\n${second}`);
    expect(result.messages).toEqual([
      { speaker: 'me', timestamp: '2026-06-02T00:00:00Z', text: 'hello' },
      { speaker: 'alice-example', timestamp: '2026-06-03T00:00:00Z', text: 'hi' },
    ]);
  });

  test('code-example date headings cannot change genuine turn timestamps', () => {
    const result = parseConversation(`${first}\n\`\`\`md\n## 2099-01-01\n${second}\n\`\`\`\n${second}`, { fallbackDate: '2026-06-02' });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map(m => m.timestamp)).toEqual(['2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z']);
  });

  test('keeps higher-priority existing formats on score ties', () => {
    const result = parseConversation(`**Alice Example** (2024-03-15 9:00 AM): old format\n${first}`);
    expect(result.matched_pattern_id).toBe('imessage-slack');
  });

  test('can be disabled through the existing registry option', () => {
    expect(parseConversation(first, { disabledBuiltinIds: ['python-dict-utterance'] }).phase).toBe('no_match');
  });

  const wrappers = [
    `{'example': '''\n${first}\n${second}\n'''}`,
    `{'example': """\n${first}\n${second}\n"""}`,
    `{'example': {\n${first}\n${second}\n}}`,
    `[\n${first}\n${second}\n]`,
    `'''\n${first}\n${second}\n'''`,
    `payload = (\n${first}\n${second}\n)`,
    `{'example': '''\n## Transcript\n${first}\n${second}\n'''}`,
  ];
  for (const [index, wrapper] of wrappers.entries()) {
    for (const [position, prefix] of [['bare', ''], ['section', '## Transcript\n'], ['after-turn', `${first}\n`]] as const) {
      test(`rejects wrapper ${index + 1} at the ${position} candidate boundary`, () => {
        const result = parseConversation(prefix + wrapper);
        expect(result.phase).toBe('no_match');
        expect(result.messages).toEqual([]);
      });
    }
  }

  for (const [index, opener] of ["{'example': '''", '{"example": {', '[', 'payload(', "r'", 'r"""'].entries()) {
    test(`an unclosed preamble wrapper ${index + 1} cannot create a Transcript section`, () => {
      const result = parseConversation(`## Summary\n${opener}\n## Transcript\n${first}\n${second}`);
      expect(result.phase).toBe('no_match');
      expect(result.messages).toEqual([]);
    });
  }

  const rejected = [
    "{'speaker': 'alice-example'}: hi",
    "{'name': 'alice-example'}: hi",
    "{'attribution': 'unknown'}: hi",
    "{'source': 'speaker', 'attribution': 'unknown'}: hi",
    "{'source': 'microphone', 'attribution': 'them'}: hi",
    "{'source': 'speaker', 'attribution': 'me', 'name': 'alice-example'}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'name': ''}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'name': '   '}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'name': 'alice-example', 'name': 'bob-example'}: hi",
    "{'source': 'speaker', 'source': 'speaker', 'attribution': 'them'}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'attribution': 'them'}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'metadata': {'name': 'alice-example'}}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'extra': 'value'}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'name': 'alice\\'example'}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'name': 'alice\\nexample'}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'name': 'alice\\u0020example'}: hi",
    "{'source': 'speaker', 'attribution': 'them', 'name': doSomething()}: hi",
    "{'source': 'speaker', 'attribution': 'them',}: hi",
    "{'source': 'speaker', 'attribution': 'them'} hi",
    "{'source': 'speaker', 'attribution': 'them'}:",
    '{"source": "speaker", "name": "alice-example", "attribution": "them"}: hi',
    `Example: ${first}`,
    `> ${first}\n> ${second}`,
    `    ${first}\n    ${second}`,
    `\t${first}\n\t${second}`,
    ` \t${first}\n \t${second}`,
    `# Example\n${first}\n${second}`,
    `\`\`\`python\n${first}\n${second}\n\`\`\``,
    `~~~~python\n${first}\n~~~\n${second}\n~~~~`,
    `\`\`\`python\n${first}\n~~~\n${second}`,
    `Here is an example of a dictionary.\n${first}\n${second}\nThis is explanatory prose.`,
    `${first}\n${second}\n${Array.from({ length: 100 }, () => 'ordinary prose').join('\n')}`,
    `## 2026-06-02\n${first}\n{'name': 'bob-example'}: unsupported\n\`\`\`python\n${second}\n\`\`\`\n## 2026-06-03\n${second}`,
  ];
  for (const [index, body] of rejected.entries()) {
    test(`rejects malformed, ambiguous, or example input ${index + 1}`, () => {
      const result = parseConversation(body);
      expect(result.phase).toBe('no_match');
      expect(result.messages).toEqual([]);
    });
  }
});

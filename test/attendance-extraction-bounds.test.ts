import { expect, test } from 'bun:test';
import { attendanceEvidenceRanges, extractPageLinks, hasAttendanceEvidence, makeResolver } from '../src/core/link-extraction.ts';
import { extractLinksFromFile } from '../src/commands/extract.ts';

const person = 'people/alice-example';
const meeting = 'meetings/planning';
const resolver = { async resolve(value: string) { return value === person ? person : null; } };
const types = new Map([[person, 'person'], [meeting, 'meeting']]);

test('a unique basename is canonical evidence while missing and ambiguous names remain incomplete', async () => {
  for (const targets of [[person], [], [person, 'archive/alice-example']]) {
    const basenameResolver = { ...resolver, async resolveBasenameMatches() { return targets; } };
    const result = await extractPageLinks(meeting, 'Attendees: [[Alice Example]]', {}, 'meeting', basenameResolver,
      { globalBasename: true, targetType: slug => targets.includes(slug) ? 'person' : undefined });
    expect(result.attendanceComplete).toBe(targets.length === 1);
    expect(result.candidates.filter(row => row.canonicalAttendance).map(row => row.targetSlug)).toEqual(targets.length === 1 ? [person] : []);
  }
});

test('commented attendance cannot borrow visible evidence and masking preserves CRLF and UTF-16 positions', async () => {
  const body = `😀\r\n<!--\r\nAttendees: [[people/hidden-example]]\r\n-->\r\nAttendees: [[${person}]]`;
  const ranges = attendanceEvidenceRanges(body);
  expect(hasAttendanceEvidence(ranges, body.indexOf('[[people/hidden-example]]'))).toBe(false);
  expect(hasAttendanceEvidence(ranges, body.indexOf(`[[${person}]]`))).toBe(true);
  const result = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
  expect(result.attendanceComplete).toBe(true);
  expect(result.candidates.filter(row => row.canonicalAttendance).map(row => row.targetSlug)).toEqual([person]);
  expect(attendanceEvidenceRanges(`<!--\nAttendees: [[${person}]]`)).toEqual([]);
});

test('strict attendance names with a non-source colon remain eligible for exact title resolution', async () => {
  const calls: unknown[][] = [];
  const engine = { async executeRaw(_sql: string, args: unknown[]) { calls.push(args); return [{ slug: person }]; } };
  const live = makeResolver(engine as never, { mode: 'batch', sourceId: 'example' });
  expect(await live.resolveAttendance!('Example Person: host', 'people')).toBe(person);
  expect(calls[0]?.[2]).toBe('Example Person: host');
  expect(await live.resolveAttendance!(`other:${person}`, 'people')).toBeNull();
  expect(calls).toHaveLength(1);
});

for (const body of [
  `Attendees: [[${person}]] <!-- [[people/hidden-example]] -->`,
  `## Attendees\r\n- [[${person}]] <!-- 😀 [[people/hidden-example]] -->\r\n## Notes`,
  `Attendees: [[${person}]] <!-- [[people/hidden-example]]`,
]) {
  test(`inline commented targets are outside accepted attendance evidence: ${JSON.stringify(body)}`, async () => {
    const pageTypes = new Map([...types, ['people/hidden-example', 'person']]);
    const ranges = attendanceEvidenceRanges(body);
    expect(hasAttendanceEvidence(ranges, body.indexOf('[[people/hidden-example]]'))).toBe(false);
    expect(hasAttendanceEvidence(ranges, body.indexOf(`[[${person}]]`))).toBe(true);
    const db = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => pageTypes.get(slug) });
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(pageTypes.keys()), { pageTypes });
    expect(db.candidates.filter(row => row.canonicalAttendance).map(row => row.targetSlug)).toEqual([person]);
    expect(fs.filter(row => row.link_type === 'attended').map(row => row.from_slug)).toEqual([person]);
  });
}

for (const example of ['```html\n<!--\n```', '~~~html\n<!--\n~~~', '`<!--`']) {
  test(`a comment opener inside code does not hide later attendance: ${JSON.stringify(example)}`, async () => {
    const body = `${example}\nAttendees: [[${person}]]`;
    const db = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
    expect(db.candidates.filter(row => row.canonicalAttendance).map(row => row.targetSlug)).toEqual([person]);
    expect(fs.filter(row => row.link_type === 'attended').map(row => row.from_slug)).toEqual([person]);
  });
}

for (const fence of ['~~~', '```', '~~~~', '````']) {
  for (const falseClose of [...new Set([fence.slice(0, 2), fence.slice(0, -1), `${fence} not a closing fence`, fence[0] === '~' ? '```' : '~~~'])]) {
    test(`attendee sections retain ${fence} state across headings and invalid closer ${falseClose}`, async () => {
      const body = `## Attendees\n${fence}\n## Example\n${falseClose}\n# Still an example\nAttendees: [Alice](../people/alice-example.md)\n${fence}\n## Notes\nNo attendance evidence.`;
      const db = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
      const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
      expect(db.candidates.filter(row => row.linkType === 'attended')).toEqual([]);
      expect(fs.filter(row => row.link_type === 'attended')).toEqual([]);
    });
    test(`attendance survives after ${fence} ignores invalid closer ${falseClose}`, async () => {
      const body = `## Attendees\n${fence}\n## Example\n${falseClose}\nAttendees: [[people/hidden-example]]\n${fence}\n## Notes\nAttendees: [[${person}]]`;
      const db = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
      const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
      expect(db.candidates.filter(row => row.linkType === 'attended').map(row => row.targetSlug)).toEqual([person]);
      expect(fs.filter(row => row.link_type === 'attended').map(row => row.from_slug)).toEqual([person]);
    });
  }
  test(`attendance resumes at exact positions after a valid ${fence} closer`, async () => {
    const body = `## Attendees\n${fence}\n## Example\nAttendees: [[people/missing-example]]\n${fence}  \n## Notes\nAttendees: [[${person}]]`;
    const db = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
    expect(db.candidates.filter(row => row.linkType === 'attended').map(row => row.targetSlug)).toEqual([person]);
    expect(fs.filter(row => row.link_type === 'attended').map(row => row.from_slug)).toEqual([person]);
  });
  test(`CRLF ${fence} fences hide examples through invalid closers and preserve later attendance`, async () => {
    const body = ['## Attendees', fence, '## Example', `${fence} not a closer`,
      'Attendees: [[people/missing-example]]', `${fence}  `, '## Notes', `Attendees: [[${person}]]`].join('\r\n');
    const db = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
    const fs = await extractLinksFromFile(`---\r\ntype: meeting\r\n---\r\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
    expect(db.candidates.filter(row => row.linkType === 'attended').map(row => row.targetSlug)).toEqual([person]);
    expect(db.attendanceComplete).toBe(true);
    expect(fs.filter(row => row.link_type === 'attended').map(row => row.from_slug)).toEqual([person]);
  });
}

test('attendance membership reads logarithmically many ordered ranges with exact boundaries', () => {
  const ranges: Array<[number, number]> = Array.from({ length: 25_000 }, (_, i) => [i * 4, i * 4 + 2]);
  let reads = 0;
  const tracked = new Proxy(ranges, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  for (const [position, expected] of [[-1, false], [0, true], [1, true], [2, false], [99_996, true], [99_998, false], [100_000, false]] as const) {
    reads = 0;
    expect(hasAttendanceEvidence(tracked, position)).toBe(expected);
    expect(reads).toBeLessThanOrEqual(16);
  }
  expect(hasAttendanceEvidence([], 0)).toBe(false);
});

test('many supported attendance entries do not multiply range scans per reference', async () => {
  const body = Array(25_000).fill(`Attendees: [[${person}]]`).join('\n');
  let start = performance.now();
  await extractPageLinks(meeting, body, {}, 'note', resolver, { targetType: slug => types.get(slug) });
  const noteMs = performance.now() - start;
  start = performance.now();
  const result = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
  const meetingMs = performance.now() - start;
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ targetSlug: person, linkType: 'attended', canonicalAttendance: true });
  expect(meetingMs).toBeLessThan(Math.max(2000, noteMs * 8));

  start = performance.now();
  await extractLinksFromFile(`---\ntype: note\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
  const fsNoteMs = performance.now() - start;
  start = performance.now();
  const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
  const fsMeetingMs = performance.now() - start;
  expect(fs).toHaveLength(25_000);
  expect(fs.every(row => row.from_slug === person && row.to_slug === meeting && row.link_type === 'attended')).toBe(true);
  expect(fsMeetingMs).toBeLessThan(Math.max(2000, fsNoteMs * 8));
}, 120_000);

test('strict attendance resolution caches repeated lookups separately within a bounded resolver lifetime', async () => {
  const calls: unknown[][] = [];
  const engine = {
    async getPage() { return { slug: person }; },
    async executeRaw(_sql: string, args: unknown[]) {
      calls.push(args);
      return args[2] === person ? [{ slug: person }] : [];
    },
  };
  const live = makeResolver(engine as never, { mode: 'live', sourceId: 'example' });
  expect(await live.resolve(person)).toBe(person);
  for (let i = 0; i < 6; i++) expect(await live.resolveAttendance!(person)).toBe(person);
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('example');
  expect(await live.resolveAttendance!(`other:${person}`)).toBeNull();
  expect(calls).toHaveLength(1);
  for (let i = 0; i < 300; i++) expect(await live.resolveAttendance!(`missing-${i}`, 'people')).toBeNull();
  const before = calls.length;
  expect(await live.resolveAttendance!(person)).toBe(person);
  expect(calls).toHaveLength(before + 1);
  expect(await makeResolver(engine as never, { mode: 'live', sourceId: 'other' }).resolveAttendance!(person)).toBe(person);
  expect(calls.at(-1)?.[0]).toBe('other');
});

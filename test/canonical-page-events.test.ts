import { describe, expect, test } from 'bun:test';
import {
  applyCanonicalInteractionEvent,
  renderCanonicalInteractionEvent,
  validateCanonicalInteractionEvent,
  type CanonicalInteractionEvent,
} from '../src/core/canonical-page-events.ts';
import { frontmatterBodyOffset } from '../src/core/markdown.ts';

const TOKEN_A = `sha256:${'a'.repeat(64)}`;
const TOKEN_B = `sha256:${'b'.repeat(64)}`;

const PAGE = `---
type: person
title: Example Person
id: person-1
company: Example Co
last_contacted: '2026-08-30'
last_interaction_channel: slack
tags:
  - contact
---

## Context

Keep this prose byte-for-byte.  

## Interactions

- 2026-08-30 · slack · Existing interaction

## Notes

Do not move this section.
`;

function event(overrides: Partial<CanonicalInteractionEvent> = {}): CanonicalInteractionEvent {
  return {
    date: '2026-09-02',
    channel: 'email',
    note: 'Discussed renewal timing',
    eventToken: TOKEN_A,
    ...overrides,
  };
}

function bodyOf(content: string): string {
  return content.slice(frontmatterBodyOffset(content));
}

describe('canonical interaction event validation', () => {
  test('renders one deterministic marker and human-readable row', () => {
    expect(renderCanonicalInteractionEvent(event())).toBe(
      `<!-- cosmic:event:v1 ${TOKEN_A} -->\n- 2026-09-02 · email · Discussed renewal timing`,
    );
  });

  test('escapes inline Markdown and HTML syntax as literal note text', () => {
    expect(renderCanonicalInteractionEvent(event({ note: 'Read *draft* and <tag> [link]' }))).toContain(
      'Read \\*draft\\* and \\<tag\\> \\[link\\]',
    );
  });

  test('rejects impossible dates, multiline injection, unsafe labels, and invalid tokens', () => {
    expect(() => validateCanonicalInteractionEvent({ ...event(), note: 42 } as unknown as CanonicalInteractionEvent)).toThrow();
    expect(() => validateCanonicalInteractionEvent(event({ date: '2026-02-30' }))).toThrow();
    expect(() => validateCanonicalInteractionEvent(event({ note: 'line one\n## Injected' }))).toThrow();
    expect(() => validateCanonicalInteractionEvent(event({ note: 'line one\u2028line two' }))).toThrow();
    expect(() => validateCanonicalInteractionEvent(event({ note: 'close --> marker' }))).toThrow();
    expect(() => validateCanonicalInteractionEvent(event({ channel: '<script>' }))).toThrow();
    expect(() => validateCanonicalInteractionEvent(event({ eventToken: 'not-a-digest' }))).toThrow();
    expect(() => validateCanonicalInteractionEvent(event({ note: 'a'.repeat(501) }))).toThrow();
  });
});

describe('canonical interaction event splice', () => {
  test('prepends newest interaction and preserves all following sections', () => {
    const next = applyCanonicalInteractionEvent(PAGE, 'people/example-person', event());
    const newAt = next.indexOf(TOKEN_A);
    const oldAt = next.indexOf('Existing interaction');
    expect(newAt).toBeGreaterThan(0);
    expect(newAt).toBeLessThan(oldAt);
    expect(next).toContain('Keep this prose byte-for-byte.  \n');
    expect(next).toContain('## Notes\n\nDo not move this section.\n');
    expect(bodyOf(next).replace(`${renderCanonicalInteractionEvent(event())}\n`, '')).toBe(bodyOf(PAGE));
    expect(next).toMatch(/last_contacted:\s+['"]?2026-09-02['"]?/);
    expect(next).toContain('last_interaction_channel: email');
  });

  test('creates the Interactions section when absent', () => {
    const without = PAGE.replace(/\n## Interactions[\s\S]*?(?=\n## Notes)/, '');
    const next = applyCanonicalInteractionEvent(without, 'people/example-person', event({
      date: '2026-08-01',
      eventToken: TOKEN_B,
    }));
    expect(next.startsWith(without)).toBe(true);
    expect(next).toContain(`## Interactions\n\n<!-- cosmic:event:v1 ${TOKEN_B} -->`);
    expect(next.indexOf('## Interactions')).toBeGreaterThan(next.indexOf('## Notes'));
  });

  test('ignores a fake Interactions heading inside fenced code', () => {
    const fenced = PAGE.replace(
      '## Interactions\n\n- 2026-08-30 · slack · Existing interaction\n',
      '```md\n## Interactions\n- fake\n```\n',
    );
    const next = applyCanonicalInteractionEvent(fenced, 'people/example-person', event());
    expect(next.match(/^## Interactions$/gm)?.length).toBe(2);
    expect(next.lastIndexOf(`<!-- cosmic:event:v1 ${TOKEN_A} -->`)).toBeGreaterThan(next.indexOf('## Notes'));
  });

  test('does not close a four-backtick fence on a shorter backtick run', () => {
    const fenced = PAGE.replace(
      '## Interactions\n\n- 2026-08-30 · slack · Existing interaction\n',
      '````md\n```\n## Interactions\n- fake\n````\n',
    );
    const next = applyCanonicalInteractionEvent(fenced, 'people/example-person', event());
    expect(next.match(/^## Interactions$/gm)?.length).toBe(2);
    expect(next.lastIndexOf(`<!-- cosmic:event:v1 ${TOKEN_A} -->`)).toBeGreaterThan(next.indexOf('## Notes'));
  });

  test('does not close a four-tilde fence on a shorter tilde run', () => {
    const fenced = PAGE.replace(
      '## Interactions\n\n- 2026-08-30 · slack · Existing interaction\n',
      '~~~~md\n~~~\n## Interactions\n- fake\n~~~~\n',
    );
    const next = applyCanonicalInteractionEvent(fenced, 'people/example-person', event());
    expect(next.match(/^## Interactions$/gm)?.length).toBe(2);
    expect(next.lastIndexOf(`<!-- cosmic:event:v1 ${TOKEN_A} -->`)).toBeGreaterThan(next.indexOf('## Notes'));
  });

  test('treats a following H1 as outside the Interactions section', () => {
    const withH1 = PAGE.replace('## Notes', '# Appendix');
    const next = applyCanonicalInteractionEvent(withH1, 'people/example-person', event());
    expect(next).toContain(`- 2026-09-02 · email · Discussed renewal timing\n- 2026-08-30`);
    expect(next).toContain('# Appendix\n\nDo not move this section.');
  });

  test('treats an empty H2 as outside the Interactions section', () => {
    const withEmptyH2 = PAGE.replace('## Notes', '##');
    const next = applyCanonicalInteractionEvent(withEmptyH2, 'people/example-person', event());
    expect(next).toContain('##\n\nDo not move this section.');
    expect(next.indexOf(TOKEN_A)).toBeLessThan(next.indexOf('\n##\n'));
  });

  test('fails closed when the canonical page has duplicate Interactions headings', () => {
    const duplicate = `${PAGE}\n## Interactions\n\n- duplicate section\n`;
    expect(() => applyCanonicalInteractionEvent(duplicate, 'people/example-person', event())).toThrow();
  });

  test('preserves an existing CRLF body suffix byte-for-byte', () => {
    const crlf = PAGE.replaceAll('\n', '\r\n');
    const historical = event({
      date: '2026-08-01',
      eventToken: TOKEN_B,
    });
    const next = applyCanonicalInteractionEvent(crlf, 'people/example-person', historical);
    const rendered = `${renderCanonicalInteractionEvent(historical).replaceAll('\n', '\r\n')}\r\n`;
    expect(bodyOf(next).replace(rendered, '')).toBe(bodyOf(crlf));
  });

  test('historical backfill appends without regressing contact metadata', () => {
    const next = applyCanonicalInteractionEvent(PAGE, 'people/example-person', event({
      date: '2026-08-01',
      channel: 'whatsapp',
      eventToken: TOKEN_B,
    }));
    expect(next).toMatch(/last_contacted:\s+['"]?2026-08-30['"]?/);
    expect(next).toContain('last_interaction_channel: slack');
    expect(next).toContain('- 2026-08-01 · whatsapp · Discussed renewal timing');
    expect(next.indexOf('Existing interaction')).toBeLessThan(next.indexOf(TOKEN_B));
  });

  test('bare YAML dates are normalized before monotonic comparison', () => {
    const bareDate = PAGE.replace("last_contacted: '2026-08-30'", 'last_contacted: 2026-08-30');
    const next = applyCanonicalInteractionEvent(bareDate, 'people/example-person', event({
      date: '2026-08-01',
      channel: 'whatsapp',
      eventToken: TOKEN_B,
    }));
    expect(next).toContain('last_contacted: 2026-08-30');
    expect(next).toContain('last_interaction_channel: slack');
  });

  test('serialized ISO timestamps participate in monotonic comparison', () => {
    const timestamp = PAGE.replace("last_contacted: '2026-08-30'", "last_contacted: '2026-08-30T00:00:00.000Z'");
    const next = applyCanonicalInteractionEvent(timestamp, 'people/example-person', event());
    expect(next).toMatch(/last_contacted:\s+['"]?2026-09-02['"]?/);
    expect(next).toContain('last_interaction_channel: email');
  });

  test('adds a line break before an older event when the final bullet has no newline', () => {
    const endingAtBullet = PAGE.slice(0, PAGE.indexOf('\n\n## Notes'))
      .replace(/\n$/, '');
    const historical = event({ date: '2026-08-01', eventToken: TOKEN_B });
    const next = applyCanonicalInteractionEvent(endingAtBullet, 'people/example-person', historical);
    expect(next).toContain(`Existing interaction\n<!-- cosmic:event:v1 ${TOKEN_B} -->`);
  });

  test('same-day event advances the latest interaction channel', () => {
    const next = applyCanonicalInteractionEvent(PAGE, 'people/example-person', event({ date: '2026-08-30' }));
    expect(next).toContain('last_interaction_channel: email');
  });

  test('marker collision fails closed instead of minting a second event', () => {
    const first = applyCanonicalInteractionEvent(PAGE, 'people/example-person', event());
    expect(() => applyCanonicalInteractionEvent(first, 'people/example-person', event())).toThrow();
    expect(first.match(new RegExp(TOKEN_A, 'g'))?.length).toBe(1);
  });
});

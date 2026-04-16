import { describe, expect, test } from 'bun:test';
import {
  compileSlackChannel,
  computeOldestTs,
  extractStructuredSignals,
  parseArgs,
  renderSlackText,
  selectChannels,
} from '../scripts/slack-sync.mjs';

const users = new Map([
  ['U1', { id: 'U1', name: 'jane', realName: 'Jane Doe', displayName: 'Jane', isBot: false, deleted: false }],
  ['U2', { id: 'U2', name: 'alex', realName: 'Alex Kim', displayName: '', isBot: false, deleted: false }],
]);

const workspace = {
  team: 'Acme Workspace',
  team_id: 'T123',
  url: 'https://acme.slack.com/',
};

const channel = {
  id: 'C123',
  name: 'client-acme',
};

describe('slack sync args', () => {
  test('parses backfill flags and channel filters', () => {
    const opts = parseArgs([
      '--days', '21',
      '--since', '2026-04-01',
      '--channel', 'eng',
      '--exclude-channel', 'random',
      '--dry-run',
    ]);

    expect(opts.days).toBe(21);
    expect(opts.since).toBe('2026-04-01');
    expect(opts.channels).toEqual(['eng']);
    expect(opts.excludeChannels).toEqual(['random']);
    expect(opts.dryRun).toBe(true);
  });

  test('incremental oldest ts honors thread lookback window', () => {
    const now = Date.now();
    const lastMessageTs = ((now - 2 * 24 * 60 * 60 * 1000) / 1000).toFixed(6);
    const oldest = computeOldestTs({ days: 7, since: null }, { lastMessageTs });
    expect(Number(oldest)).toBeLessThanOrEqual(Number(lastMessageTs));
  });
});

describe('slack sync rendering', () => {
  test('renders user mentions as people links', () => {
    const rendered = renderSlackText(
      'Please follow up with <@U1> on the rollout.',
      users,
      'sources/slack/acme/client-acme/2026-04-15-digest.md',
    );

    expect(rendered).toContain('[Jane](../../../../people/jane-doe.md)');
  });

  test('extracts decisions, actions, and links deterministically', () => {
    const signal = extractStructuredSignals({
      text: 'We decided to ship Friday. Jane, please follow up. https://example.com/spec',
      ts: '1713200000.000100',
      user: 'U1',
    }, users, 'sources/slack/acme/client-acme/2026-04-15-digest.md');

    expect(signal.decisions).toHaveLength(1);
    expect(signal.actionItems).toHaveLength(1);
    expect(signal.links[0].url).toBe('https://example.com/spec');
  });
});

describe('slack channel compilation', () => {
  test('builds a thread page and a digest page', () => {
    const historyMessages = [
      {
        ts: '1713200000.000100',
        thread_ts: '1713200000.000100',
        reply_count: 1,
        text: 'We decided to launch Friday. <@U2> please follow up with the client. https://example.com/launch-plan',
        user: 'U1',
      },
      {
        ts: '1713203600.000100',
        text: 'Need to send the recap by EOD.',
        user: 'U2',
      },
    ];

    const threadMessagesByRoot = new Map([
      ['1713200000.000100', [
        historyMessages[0],
        {
          ts: '1713201800.000100',
          thread_ts: '1713200000.000100',
          text: 'Agreed. I will send it after the call.',
          user: 'U2',
        },
      ]],
    ]);

    const pages = compileSlackChannel({
      workspace,
      channel,
      historyMessages,
      threadMessagesByRoot,
      users,
      outputRoot: 'sources/slack',
      timeZone: 'America/Los_Angeles',
    });

    expect(pages).toHaveLength(2);
    expect(pages.some((page) => page.path.endsWith('-digest.md'))).toBe(true);
    expect(pages.some((page) => page.content.includes('## Decisions'))).toBe(true);
    expect(pages.some((page) => page.content.includes('## Shared Links'))).toBe(true);
    expect(pages.some((page) => page.content.includes('[Jane]('))).toBe(true);
  });
});

describe('channel filtering', () => {
  test('skips noisy channels by default and respects explicit include', () => {
    const channels = [
      { id: 'C1', name: 'eng', is_archived: false, is_member: true },
      { id: 'C2', name: 'random', is_archived: false, is_member: true },
    ];

    const selected = selectChannels(channels, {
      channels: [],
      excludeChannels: [],
      allChannels: false,
    });
    expect(selected.map((channel: any) => channel.name)).toEqual(['eng']);

    const forced = selectChannels(channels, {
      channels: ['random'],
      excludeChannels: [],
      allChannels: false,
    });
    expect(forced.map((channel: any) => channel.name)).toEqual(['random']);
  });
});

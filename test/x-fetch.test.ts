import { describe, expect, test } from 'bun:test';
import {
  parseTweetIdFromUrl,
  unwrapResult,
  normalizeTweetResult,
} from '../src/core/x/fetch-tweet.ts';

describe('parseTweetIdFromUrl', () => {
  test('extracts tweet ID from standard URL', () => {
    expect(parseTweetIdFromUrl('https://x.com/karpathy/status/2039805659525644595')).toBe(
      '2039805659525644595',
    );
  });

  test('extracts tweet ID from twitter.com URL', () => {
    expect(
      parseTweetIdFromUrl('https://twitter.com/user/status/123456789'),
    ).toBe('123456789');
  });

  test('returns null for invalid URL', () => {
    expect(parseTweetIdFromUrl('https://x.com/karpathy')).toBeNull();
    expect(parseTweetIdFromUrl('not-a-url')).toBeNull();
  });
});

describe('unwrapResult', () => {
  test('returns null for falsy input', () => {
    expect(unwrapResult(null)).toBeNull();
    expect(unwrapResult(undefined)).toBeNull();
    expect(unwrapResult(0)).toBeNull();
  });

  test('unwraps nested tweet_results', () => {
    const input = {
      tweet_results: {
        result: {
          rest_id: '123',
          legacy: { full_text: 'hello' },
        },
      },
    };
    const result = unwrapResult(input);
    expect(result.rest_id).toBe('123');
  });

  test('unwraps TweetWithVisibilityResults', () => {
    const input = {
      __typename: 'TweetWithVisibilityResults',
      tweet: {
        rest_id: '456',
        legacy: { full_text: 'visible tweet' },
      },
    };
    const result = unwrapResult(input);
    expect(result.rest_id).toBe('456');
  });

  test('handles TweetTombstone', () => {
    const input = {
      __typename: 'TweetTombstone',
      rest_id: '789',
      tombstone_info: {
        text: { text: 'This tweet was deleted' },
      },
    };
    const result = unwrapResult(input);
    expect(result.tombstone).toBe(true);
    expect(result.text).toBe('This tweet was deleted');
  });

  test('returns plain object as-is', () => {
    const input = { rest_id: '999', legacy: {} };
    expect(unwrapResult(input)).toBe(input);
  });
});

describe('normalizeTweetResult', () => {
  test('returns null for null input', () => {
    expect(normalizeTweetResult(null, 'https://x.com/user/status/1')).toBeNull();
  });

  test('normalizes a standard tweet', () => {
    const raw = {
      result: {
        rest_id: '123',
        legacy: {
          full_text: 'Hello world',
          created_at: 'Mon Jan 01 00:00:00 +0000 2024',
          conversation_id_str: '123',
          in_reply_to_status_id_str: null,
          reply_count: 5,
          retweet_count: 10,
          favorite_count: 50,
          quote_count: 2,
          bookmark_count: 3,
          entities: {
            urls: [
              {
                url: 'https://t.co/abc',
                expanded_url: 'https://example.com',
                display_url: 'example.com',
              },
            ],
          },
        },
        core: {
          user_results: {
            result: {
              rest_id: 'u1',
              is_blue_verified: true,
              core: { screen_name: 'karpathy', name: 'Andrej Karpathy' },
              legacy: {},
            },
          },
        },
        views: { count: '100000' },
      },
    };

    const result = normalizeTweetResult(raw, 'https://x.com/karpathy/status/123');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('123');
    expect(result!.text).toBe('Hello world');
    expect(result!.author.handle).toBe('karpathy');
    expect(result!.author.name).toBe('Andrej Karpathy');
    expect(result!.author.verified).toBe(true);
    expect(result!.metrics!.likes).toBe(50);
    expect(result!.metrics!.reposts).toBe(10);
    expect(result!.metrics!.views).toBe('100000');
    expect(result!.urls).toHaveLength(1);
    expect(result!.urls![0].expandedUrl).toBe('https://example.com');
  });

  test('prefers note_tweet text over full_text (long posts)', () => {
    const raw = {
      result: {
        rest_id: '456',
        legacy: {
          full_text: 'Truncated...',
        },
        note_tweet: {
          note_tweet_results: {
            result: {
              text: 'This is the full long post content that exceeds 280 characters',
            },
          },
        },
        core: {
          user_results: {
            result: {
              rest_id: 'u2',
              core: { screen_name: 'user' },
              legacy: {},
            },
          },
        },
      },
    };

    const result = normalizeTweetResult(raw, 'https://x.com/user/status/456');
    expect(result!.text).toBe(
      'This is the full long post content that exceeds 280 characters',
    );
  });

  test('handles tombstone tweet', () => {
    const raw = {
      result: {
        __typename: 'TweetTombstone',
        rest_id: '789',
        tombstone_info: {
          text: { text: 'This tweet is unavailable' },
        },
      },
    };

    const result = normalizeTweetResult(raw, 'https://x.com/user/status/789');
    expect(result!.tombstone).toBe(true);
    expect(result!.text).toBe('This tweet is unavailable');
  });
});

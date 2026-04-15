import { chromium } from 'playwright';

export const parseTweetIdFromUrl = (url) => {
  const match = url.match(/status\/(\d+)/);
  return match?.[1] ?? null;
};

const createDeferred = () => {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = (value) => {
      settled = true;
      resolve(value);
    };
    rejectPromise = (error) => {
      settled = true;
      reject(error);
    };
  });

  return {
    promise,
    get settled() {
      return settled;
    },
    resolve: resolvePromise,
    reject: rejectPromise,
  };
};

const unwrapResult = (result) => {
  if (!result || typeof result !== 'object') {
    return null;
  }

  if ('tweet' in result && result.tweet) {
    return unwrapResult(result.tweet);
  }

  if ('result' in result && result.result) {
    return unwrapResult(result.result);
  }

  if ('tweet_results' in result && result.tweet_results) {
    return unwrapResult(result.tweet_results);
  }

  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
    return unwrapResult(result.tweet);
  }

  if (result.__typename === 'TweetTombstone') {
    return {
      rest_id: result.rest_id ?? null,
      tombstone: true,
      text:
        result.tombstone_info?.text?.text ??
        result.tombstone_info?.rich_text?.text ??
        null,
    };
  }

  return result;
};

const collectUrls = (entities) =>
  (entities?.urls ?? []).map((entry) => ({
    url: entry.url ?? null,
    expandedUrl: entry.expanded_url ?? null,
    displayUrl: entry.display_url ?? null,
  }));

const collectMedia = (legacyTweet) =>
  (legacyTweet?.extended_entities?.media ?? legacyTweet?.entities?.media ?? []).map(
    (media) => ({
      type: media.type ?? null,
      mediaUrlHttps: media.media_url_https ?? null,
      expandedUrl: media.expanded_url ?? null,
      displayUrl: media.display_url ?? null,
    }),
  );

export const normalizeTweetResult = (rawResult, sourceUrl) => {
  const tweet = unwrapResult(rawResult);

  if (!tweet) {
    return null;
  }

  if (tweet.tombstone) {
    return {
      id: tweet.rest_id,
      url: sourceUrl,
      text: tweet.text,
      tombstone: true,
    };
  }

  const legacyTweet = tweet.legacy ?? {};
  const noteTweet =
    tweet.note_tweet?.note_tweet_results?.result?.text ??
    tweet.note_tweet?.note_tweet_results?.result?.entity_set?.text ??
    null;
  const user = unwrapResult(tweet.core?.user_results) ?? {};
  const userCore = user.core ?? {};
  const legacyUser = user.legacy ?? {};

  return {
    id: tweet.rest_id ?? null,
    url: sourceUrl,
    conversationId: legacyTweet.conversation_id_str ?? null,
    inReplyToStatusId: legacyTweet.in_reply_to_status_id_str ?? null,
    inReplyToScreenName: legacyTweet.in_reply_to_screen_name ?? null,
    createdAt: legacyTweet.created_at ?? null,
    lang: legacyTweet.lang ?? null,
    text: noteTweet ?? legacyTweet.full_text ?? null,
    author: {
      id: user.rest_id ?? null,
      handle: userCore.screen_name ?? legacyUser.screen_name ?? null,
      name: userCore.name ?? legacyUser.name ?? null,
      verified: user.is_blue_verified ?? null,
    },
    metrics: {
      replies: legacyTweet.reply_count ?? null,
      reposts: legacyTweet.retweet_count ?? null,
      likes: legacyTweet.favorite_count ?? null,
      quotes: legacyTweet.quote_count ?? null,
      bookmarks: legacyTweet.bookmark_count ?? null,
      views: tweet.views?.count ?? null,
    },
    urls: collectUrls(legacyTweet.entities),
    media: collectMedia(legacyTweet),
    quotedTweetId: unwrapResult(tweet.quoted_status_result)?.rest_id ?? null,
  };
};

export const createXBrowserSession = async ({ storageStatePath } = {}) => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9',
    },
    storageState: storageStatePath || undefined,
  });

  return { browser, context };
};

export const fetchTweetByUrl = async (
  targetUrl,
  { context, includeRaw = false, timeoutMs = 45_000 } = {},
) => {
  const tweetId = parseTweetIdFromUrl(targetUrl);
  const page = await context.newPage();
  let graphqlPayload = null;
  let graphqlError = null;
  const tweetResultDeferred = createDeferred();

  page.on('response', async (response) => {
    const responseUrl = response.url();
    if (!responseUrl.includes('TweetResultByRestId')) {
      return;
    }

    try {
      const parsed = new URL(responseUrl);
      const variablesParam = parsed.searchParams.get('variables');
      if (!variablesParam) {
        return;
      }

      const variables = JSON.parse(variablesParam);
      if (tweetId && variables.tweetId !== tweetId) {
        return;
      }

      graphqlPayload = await response.json();
      if (!tweetResultDeferred.settled) {
        tweetResultDeferred.resolve(graphqlPayload);
      }
    } catch (error) {
      graphqlError = error instanceof Error ? error.message : String(error);
      if (!tweetResultDeferred.settled) {
        tweetResultDeferred.reject(error);
      }
    }
  });

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });

  await Promise.race([
    tweetResultDeferred.promise.catch(() => null),
    page.waitForSelector('[data-testid="tweetText"]', {
      timeout: Math.min(timeoutMs, 15_000),
    }).catch(() => null),
  ]);

  await page.waitForTimeout(2_000);

  const pageState = await page
    .evaluate(() => {
      const visibleTweets = Array.from(
        document.querySelectorAll('article[data-testid="tweet"]'),
      ).map((article) => {
        const statusLink = article.querySelector('a[href*="/status/"]');
        const href = statusLink?.getAttribute('href') ?? null;
        const statusId = href?.match(/status\/(\d+)/)?.[1] ?? null;
        const handle = href?.split('/').filter(Boolean)?.[0] ?? null;
        const text =
          article.querySelector('[data-testid="tweetText"]')?.textContent ?? null;

        return {
          href,
          statusId,
          handle,
          text,
        };
      });

      return {
        title: document.title,
        hasLoggedOutReadRepliesPivot: Boolean(
          document.querySelector('[data-testid="logged_out_read_replies_pivot"]'),
        ),
        visibleTweets,
      };
    })
    .catch(() => ({
      title: null,
      hasLoggedOutReadRepliesPivot: false,
      visibleTweets: [],
    }));

  const normalized =
    normalizeTweetResult(graphqlPayload?.data?.tweetResult, targetUrl) ??
    (pageState.visibleTweets[0]
      ? {
          id: pageState.visibleTweets[0].statusId ?? tweetId,
          url: targetUrl,
          text: pageState.visibleTweets[0].text,
          author: {
            handle: pageState.visibleTweets[0].handle,
          },
          title: pageState.title,
          fromDomFallback: true,
        }
      : null);

  const result = {
    targetUrl,
    tweetId,
    graphqlCaptured: Boolean(graphqlPayload),
    graphqlError,
    normalized,
    pageState,
  };

  if (includeRaw) {
    result.rawGraphql = graphqlPayload;
  }

  await page.close();

  return result;
};

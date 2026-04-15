/**
 * TypeScript types for X/Twitter scraping pipeline.
 */

export interface TweetAuthor {
  id: string | null;
  handle: string | null;
  name: string | null;
  verified: boolean | null;
}

export interface TweetMetrics {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  quotes: number | null;
  bookmarks: number | null;
  views: string | null;
}

export interface TweetUrl {
  url: string | null;
  expandedUrl: string | null;
  displayUrl: string | null;
}

export interface TweetMedia {
  type: string | null;
  mediaUrlHttps: string | null;
  expandedUrl: string | null;
  displayUrl: string | null;
}

export interface NormalizedTweet {
  id: string | null;
  url: string;
  conversationId?: string | null;
  inReplyToStatusId?: string | null;
  inReplyToScreenName?: string | null;
  createdAt?: string | null;
  lang?: string | null;
  text: string | null;
  author: TweetAuthor;
  metrics?: TweetMetrics;
  urls?: TweetUrl[];
  media?: TweetMedia[];
  quotedTweetId?: string | null;
  tombstone?: boolean;
  fromDomFallback?: boolean;
  title?: string | null;
}

export interface VisibleTweet {
  href: string | null;
  statusId: string | null;
  handle: string | null;
  text: string | null;
}

export interface PageState {
  title: string | null;
  hasLoggedOutReadRepliesPivot: boolean;
  visibleTweets: VisibleTweet[];
}

export interface FetchTweetResult {
  targetUrl: string;
  tweetId: string | null;
  graphqlCaptured: boolean;
  graphqlError: string | null;
  normalized: NormalizedTweet | null;
  pageState: PageState;
  rawGraphql?: unknown;
}

export interface ThreadReply {
  id: string;
  url: string;
  inReplyToStatusId: string | null;
  text: string | null;
}

export interface ThreadResult {
  url: string;
  author: string | null;
  rootId: string | null;
  candidateIds?: string[];
  thread: ThreadReply[];
  notes?: string[];
}

export interface FetchBatchResult {
  source: string;
  urls: string[];
  results: FetchTweetResult[];
}

export interface ThreadBatchResult {
  source: string;
  results: ThreadResult[];
}

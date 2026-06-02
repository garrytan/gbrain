---
title: "Screen Flicker Issue"
type: guide
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
conversation_id: 69e8000c-f1d4-83e8-be86-8578f977adb8
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Screen Flicker Issue

**Related:** [[coding_troubleshoot]]

> Conversation ID: 69e8000c-f1d4-83e8-be86-8578f977adb8
> Created: 2026-04-21T22:54:05Z
> Updated: 2026-04-21T22:56:36Z
> Messages: 3

---

## User

Yeah, one thing that keeps hitting us is like weird glitches where the screen will look correct and then flicker to something incorrect and then flicker back to correct. Um, but it's hard to figure out how to get coverage on that test-wise. Um, how can you handle that? It's a particular issue a lot with AI chat interfaces where the text streaming will start, then the whole page will blank out and then it'll come back with a new loaded state. Um, and it happens a lot with like caching and validation issues or like app updates that are happening that take longer.

---

## Assistant

Mr. White, I’ll frame this as a testing pattern for transient UI regressions: detect “bad intermediate states,” reproduce them with controlled delays, and make the failure debuggable with trace/video evidence.

---

## Assistant

Mr. White, treat this as a **temporal UI invariant** problem.

A normal test says: “after streaming finishes, the page looks right.”  
Your bug requires a test that says: **“from the moment streaming starts until it finishes, the chat thread never disappears, never shows the full-page loader, and never loses already-rendered text.”**

## 1. Define forbidden intermediate states

For AI chat, I’d usually guard these:

| Invariant | Failure it catches |
|---|---|
| Chat thread stays mounted | Whole page blanks, Suspense fallback, remount |
| Existing messages remain visible | Cache invalidation wipes the list |
| Assistant streaming text never resets to empty | Streaming state replaced by loading state |
| Full-page loader never appears after first token | Global revalidation fallback |
| Message count never drops | Query cache clears old data |
| Current assistant text length never decreases materially | Bad stream reconciliation, bad keying |
| Input area remains mounted | Page-level reload / route refresh |
| Body/main text length never collapses below threshold | White screen / blank shell |

This turns “weird flicker” into something measurable.

## 2. Add a continuous UI watchdog to E2E tests

Final-state assertions will miss a flicker that lasts 100 ms. Add a small monitor that samples the DOM throughout the risky window.

Example with Playwright:

```ts
import { expect, Page } from '@playwright/test';

export async function startChatFlickerWatch(page: Page) {
  await page.evaluate(() => {
    const w = window as any;

    w.__chatFlickerViolations = [];
    w.__chatFlickerLastAssistantText = '';
    w.__chatFlickerSeenAssistantToken = false;

    const isVisible = (el: Element | null) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        el.getClientRects().length > 0
      );
    };

    const record = (reason: string) => {
      w.__chatFlickerViolations.push({
        reason,
        timeMs: Math.round(performance.now()),
        bodyText: document.body.innerText.slice(0, 1000),
        url: location.href,
      });
    };

    const sample = () => {
      const chatThread = document.querySelector('[data-testid="chat-thread"]');
      const assistantMessage = document.querySelector('[data-testid="assistant-message-current"]');
      const fullPageLoader = document.querySelector('[data-testid="full-page-loader"]');
      const appShell = document.querySelector('[data-testid="app-shell"]');

      const assistantText = assistantMessage?.textContent?.trim() ?? '';
      const bodyText = document.body.innerText.trim();

      if (assistantText.length > 0) {
        w.__chatFlickerSeenAssistantToken = true;
      }

      if (!appShell) {
        record('app shell unmounted');
      }

      if (!chatThread) {
        record('chat thread unmounted');
      }

      if (w.__chatFlickerSeenAssistantToken && bodyText.length < 20) {
        record('page became nearly blank after streaming started');
      }

      if (w.__chatFlickerSeenAssistantToken && isVisible(fullPageLoader)) {
        record('full-page loader appeared after assistant token was visible');
      }

      if (
        w.__chatFlickerSeenAssistantToken &&
        w.__chatFlickerLastAssistantText.length > 20 &&
        assistantText.length < w.__chatFlickerLastAssistantText.length - 10
      ) {
        record('assistant text regressed during streaming');
      }

      if (assistantText.length > w.__chatFlickerLastAssistantText.length) {
        w.__chatFlickerLastAssistantText = assistantText;
      }

      w.__chatFlickerRaf = requestAnimationFrame(sample);
    };

    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    w.__chatFlickerObserver = observer;
    w.__chatFlickerRaf = requestAnimationFrame(sample);
  });
}

export async function expectNoChatFlicker(page: Page) {
  const violations = await page.evaluate(() => {
    const w = window as any;
    return w.__chatFlickerViolations ?? [];
  });

  expect(violations).toEqual([]);
}
```

Then use it around the streaming flow:

```ts
test('chat does not blank or show global loading state while streaming', async ({ page }) => {
  await page.goto('/chat/test-thread');

  await startChatFlickerWatch(page);

  await page.getByRole('textbox').fill('Explain caching bugs in one paragraph');
  await page.getByRole('button', { name: /send/i }).click();

  await expect(page.getByTestId('assistant-message-current')).toContainText(/./);

  // Keep watching during the dangerous period.
  await page.waitForTimeout(5000);

  await expect(page.getByTestId('assistant-message-current')).toContainText(/caching/i);

  await expectNoChatFlicker(page);
});
```

Playwright’s normal assertions auto-retry until a desired condition is met, which is useful for final/positive checks, but transient “never show this bad state” bugs need this kind of continuous guard. citeturn577911search0turn577911search9

## 3. Reproduce the conditions deliberately

Do a “chaos streaming” test suite. You want deterministic versions of the real bad cases:

```ts
test.describe('chat streaming stability', () => {
  test('slow first token', async ({ page }) => {});
  test('slow middle chunk', async ({ page }) => {});
  test('query invalidation during stream', async ({ page }) => {});
  test('route refresh during stream', async ({ page }) => {});
  test('stale cache replaced during stream', async ({ page }) => {});
  test('app version update during stream', async ({ page }) => {});
  test('network reconnect during stream', async ({ page }) => {});
  test('background refetch while assistant message is rendering', async ({ page }) => {});
});
```

The most valuable one is usually:

```ts
test('background revalidation does not replace visible chat with loading state', async ({ page }) => {
  await page.goto('/chat/existing-thread');

  await startChatFlickerWatch(page);

  await page.getByRole('textbox').fill('Start streaming');
  await page.getByRole('button', { name: /send/i }).click();

  await expect(page.getByTestId('assistant-message-current')).toContainText(/./);

  // Trigger the exact class of thing that causes flicker in production.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });

  await page.getByTestId('force-revalidate-button').click();

  await page.waitForTimeout(5000);

  await expectNoChatFlicker(page);
});
```

Expose test-only triggers for the failure modes:

```tsx
{process.env.NODE_ENV === 'test' && (
  <button
    data-testid="force-revalidate-button"
    onClick={() => {
      queryClient.invalidateQueries({ queryKey: ['chat-thread'] });
    }}
  >
    Force revalidate
  </button>
)}
```

This gives you coverage for the exact production issue instead of hoping the race happens in CI.

## 4. Add visual and trace artifacts for failures

For these bugs, the failure needs evidence. Enable trace, screenshot, and video on failure:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  retries: process.env.CI ? 2 : 0,
});
```

Playwright supports traces, videos, and screenshots in test config; traces are especially useful because they include the test timeline, DOM snapshots, and network activity. citeturn577911search13turn577911search5turn577911search18

Visual snapshots can help, but use them carefully. `toHaveScreenshot()` waits for two consecutive stable screenshots before comparing, which is good for stable visual regression testing and can smooth over the earlier flicker you are trying to catch. Use screenshot assertions for final layout, and use the watchdog for transient blank/loading states. citeturn577911search1turn577911search7

## 5. Instrument the app with explicit UI states

The tests get much easier if the app exposes stable state markers:

```tsx
<main
  data-testid="chat-thread"
  data-chat-state={
    isStreaming
      ? 'streaming'
      : isRevalidating
        ? 'revalidating'
        : 'ready'
  }
>
  {messages.map(message => (
    <MessageRow
      key={message.id}
      message={message}
      data-testid={
        message.role === 'assistant' && message.status === 'streaming'
          ? 'assistant-message-current'
          : 'message-row'
      }
    />
  ))}
</main>
```

Then your invariant becomes simple:

```ts
await expect(page.getByTestId('chat-thread')).toBeVisible();

await expect(page.getByTestId('chat-thread')).toHaveAttribute(
  'data-chat-state',
  /streaming|revalidating|ready/
);
```

Also add a dedicated full-page loader marker:

```tsx
{isInitialPageLoad && (
  <FullPageLoader data-testid="full-page-loader" />
)}
```

The important product rule is: **initial page load may use a full-page loader; revalidation during an already-visible chat should preserve the current chat and show only a small local pending indicator.**

## 6. Common root causes to fix

These are the patterns that usually cause the flicker:

| Cause | Fix |
|---|---|
| Suspense boundary wraps the whole chat page | Move fallback boundary lower; keep chat shell mounted |
| Revalidation clears cached data | Keep previous data visible during refetch |
| Streaming message uses unstable React keys | Key messages by durable message ID, never array index |
| Current assistant message is replaced on every chunk | Append/update same message object by ID |
| Route refresh triggers global loading UI | Separate initial loading from background revalidation |
| Query invalidation during stream reloads the thread | Defer invalidation until stream completes or merge updates |
| Deploy/app update causes hard reload state | Preserve shell and local draft/stream state across refresh where possible |
| Empty state condition races with loading condition | Make empty/loading/ready/streaming mutually exclusive states |

For chat UIs, I’d make this a hard rule in code review:

```ts
// During streaming, these should never happen:
messages.length === 0
currentAssistantMessage == null
showFullPageLoader === true
chatThreadUnmounted === true
```

## 7. Add production detection too

Some flickers will happen only under real network/app-update timing. Add a lightweight client-side detector:

```ts
let seenAssistantToken = false;
let lastBodyTextLength = 0;

export function markAssistantTokenSeen() {
  seenAssistantToken = true;
}

export function startBlankPageDetector() {
  setInterval(() => {
    if (!seenAssistantToken) return;

    const bodyLength = document.body.innerText.trim().length;

    if (lastBodyTextLength > 200 && bodyLength < 20) {
      console.warn('chat_ui_blank_after_stream_started', {
        bodyLength,
        lastBodyTextLength,
        url: location.href,
        time: Date.now(),
      });

      // Send to Sentry/PostHog/Datadog/etc.
    }

    lastBodyTextLength = Math.max(lastBodyTextLength, bodyLength);
  }, 100);
}
```

Better event names:

```ts
chat_ui_thread_unmounted_during_stream
chat_ui_global_loader_visible_during_stream
chat_ui_message_count_decreased_during_stream
chat_ui_assistant_text_regressed
chat_ui_blank_body_after_first_token
```

## The practical implementation order

1. Add `data-testid` markers for app shell, chat thread, current assistant message, and full-page loader.  
2. Add the Playwright watchdog helper.  
3. Add one deterministic slow-stream test.  
4. Add one deterministic revalidation-during-stream test.  
5. Enable trace/video/screenshot on failure.  
6. Fix architecture so background refresh preserves already-visible chat content.  

The highest-value test is:

> Start with an existing chat, begin assistant streaming, trigger cache invalidation or route refresh mid-stream, and assert the chat thread never unmounts, the full-page loader never appears, and assistant text never resets.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]

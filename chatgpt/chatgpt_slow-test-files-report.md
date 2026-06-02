---
title: "Slow test files report"
type: note
created: 2026-01-18
updated: 2026-01-18
source: chatgpt-export
conversation_id: 696c5224-13f4-8329-8e9b-cdf94bf529e2
message_count: 2
tags: [chatgpt, import, long-form]
---
# Slow test files report

> Conversation ID: 696c5224-13f4-8329-8e9b-cdf94bf529e2
> Created: 2026-01-18T03:23:29Z
> Updated: 2026-01-18T03:23:45Z
> Messages: 2

---

## User

Skip to content
Navigation Menu
JovieInc
Jovie

Type / to search
Code
Issues
73
Pull requests
Discussions
Actions
Projects
Wiki
Security
26
Insights
Settings
CI
feat(dsp): add DSP match list component with empty states #4848
All jobs
Run details
Unit Tests
Started 2m 11s ago
Search logs
1s
2s
0s
0s
24s
0s
1m 43s
Run if [ "refs/pull/2084/merge" = "refs/heads/main" ]; then
🔍 PR: Running critical tests + tests changed since main
> @jovie/web@0.1.0 test /home/runner/work/Jovie/Jovie/apps/web
> NODE_OPTIONS=--max-old-space-size=8192 vitest run --config=vitest.config.mts "--" "critical"
[dotenv@17.2.3] injecting env (0) from .env.test -- tip: 👥 sync secrets across teammates & machines: https://dotenvx.com/ops
 RUN  v3.2.4 /home/runner/work/Jovie/Jovie/apps/web
 ✓ tests/unit/lib/stripe/webhooks/handlers/payment-handler.critical.test.ts (23 tests) 19ms
 ✓ tests/unit/lib/stripe/webhooks/handlers/subscription-handler.critical.test.ts (26 tests) 23ms
 ✓ tests/unit/lib/stripe/customer-sync.test.ts (27 tests) 26ms
 ✓ tests/unit/links/useLinksManager.test.ts (47 tests) 124ms
 ✓ tests/unit/links/useSuggestions.test.ts (31 tests) 79ms
 ✓ tests/unit/components/admin/csv-export.test.tsx (41 tests) 273ms
3:21:14 AM [vite] (client) warning: Converting "require" to "esm" is currently not supported
539|    // For sync initialization, we always use lite SDK
540|    // If full mode was requested, it will be upgraded later
541|    const { initLiteSentry } = require('./client-lite');
   |                               ^
542|    const success = initLiteSentry(liteOptions);
543|  

  Plugin: vite:esbuild
  File: /home/runner/work/Jovie/Jovie/apps/web/lib/sentry/init.ts
 ✓ tests/unit/lib/sentry/sentry-init.test.ts (140 tests) 23ms
 ✓ tests/unit/links/link-categorization.test.ts (65 tests) 17ms
 ✓ tests/unit/lib/security-headers.test.ts (72 tests) 17ms
 ✓ tests/unit/api/stripe/webhooks.test.ts (13 tests) 33ms
 ✓ tests/unit/links/link-display-utils.test.ts (73 tests) 26ms
 ✓ tests/unit/lib/utils/csv.test.ts (60 tests) 22ms
 ✓ tests/unit/links/IngestedSuggestions.test.tsx (25 tests) 285ms
stderr | tests/unit/components/molecules/AvatarUploadable.test.tsx > AvatarUploadable Component > Display Mode (Non-uploadable) > renders as regular avatar when uploadable is false
Warning: Received `false` for a non-boolean attribute `priority`.
If you want to write it to the DOM, pass a string instead: priority="false" or priority={value.toString()}.
If you used to conditionally omit it with priority={condition && value}, pass priority={condition ? value : undefined} instead.
    at img
    at spy (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/dist/index.js:47:80)
    at div
    at div
    at Avatar (/home/runner/work/Jovie/Jovie/apps/web/components/atoms/Avatar/Avatar.tsx:79:3)
    at div
    at AvatarUploadable2 (/home/runner/work/Jovie/Jovie/apps/web/components/organisms/AvatarUploadable.tsx:50:5)
Warning: React does not recognize the `blurDataURL` prop on a DOM element. If you intentionally want it to appear in the DOM as a custom attribute, spell it as lowercase `blurdataurl` instead. If you accidentally passed it from a parent component, remove it from the DOM element.
    at img
    at spy (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/dist/index.js:47:80)
    at div
    at div
    at Avatar (/home/runner/work/Jovie/Jovie/apps/web/components/atoms/Avatar/Avatar.tsx:79:3)
    at div
    at AvatarUploadable2 (/home/runner/work/Jovie/Jovie/apps/web/components/organisms/AvatarUploadable.tsx:50:5)
 ❯ tests/unit/components/molecules/AvatarUploadable.test.tsx (25 tests | 4 failed | 1 skipped) 252ms
   ✓ AvatarUploadable Component > Display Mode (Non-uploadable) > renders as regular avatar when uploadable is false 88ms
   ✓ AvatarUploadable Component > Display Mode (Non-uploadable) > does not show hover overlay when not uploadable 5ms
   ✓ AvatarUploadable Component > Upload Mode > renders with upload functionality when uploadable is true 16ms
   ✓ AvatarUploadable Component > Upload Mode > shows file input for upload 5ms
   ✓ AvatarUploadable Component > File Upload Interactions > triggers file input click when avatar is clicked 10ms
   ✓ AvatarUploadable Component > File Upload Interactions > handles keyboard interaction (Enter and Space) 10ms
   ✓ AvatarUploadable Component > File Upload Interactions > calls onUpload when file is selected 15ms
   ✓ AvatarUploadable Component > File Validation > validates file type and shows error for invalid types 7ms
   ✓ AvatarUploadable Component > File Validation > validates file size and shows error for large files 6ms
   ✓ AvatarUploadable Component > File Validation > accepts valid file types 13ms
   ✓ AvatarUploadable Component > File Validation > accepts HEIC by default to match API support 6ms
   ✓ AvatarUploadable Component > File Validation > can be configured to reject HEIC when disabled upstream 4ms
   ✓ AvatarUploadable Component > File Validation > enforces 25MB default max file size 4ms
   ✓ AvatarUploadable Component > Drag and Drop > handles drag enter and shows drag overlay 6ms
   ✓ AvatarUploadable Component > Drag and Drop > handles file drop and triggers upload 7ms
   ✓ AvatarUploadable Component > Drag and Drop > prevents default drag behavior 7ms
   ✓ AvatarUploadable Component > Progress States > shows progress ring during upload 5ms
   ✓ AvatarUploadable Component > Progress States > announces progress to screen readers 3ms
   × AvatarUploadable Component > Progress States > shows success state with check icon 9ms
     → Timers are not mocked. Try calling "vi.useFakeTimers()" first.
   × AvatarUploadable Component > Progress States > shows error state when upload fails 5ms
     → Timers are not mocked. Try calling "vi.useFakeTimers()" first.
   × AvatarUploadable Component > Analytics Tracking > tracks upload events 5ms
     → Timers are not mocked. Try calling "vi.useFakeTimers()" first.
   ↓ AvatarUploadable Component > Analytics Tracking > tracks validation errors
   ✓ AvatarUploadable Component > Accessibility > has proper ARIA labels and roles 3ms
   × AvatarUploadable Component > Accessibility > announces status changes to screen readers 7ms
     → Timers are not mocked. Try calling "vi.useFakeTimers()" first.
   ✓ AvatarUploadable Component > Accessibility > has keyboard focus management 4ms
 ✓ tests/unit/lib/stripe/webhooks/handlers/checkout-handler.critical.test.ts (15 tests) 14ms
 ✓ tests/unit/lib/auth/session.critical.test.ts (27 tests) 50ms
 ❯ tests/contracts/dashboard-apis.spec.ts (9 tests | 1 failed) 365ms
   ✓ Dashboard API contracts > Analytics > returns analytics payload with normalized arrays 19ms
   ✓ Dashboard API contracts > Analytics > surfaces unauthorized responses with consistent shape 1ms
   ✓ Dashboard API contracts > Recent activity > formats audience, visit, and click events into activity feed 140ms
   ✓ Dashboard API contracts > Audience endpoints > validates audience members requests and returns normalized payloads 11ms
   ✓ Dashboard API contracts > Audience endpoints > paginates subscribers with contract-safe response 8ms
   ✓ Dashboard API contracts > Profile > returns current profile with caching headers 92ms
   × Dashboard API contracts > Profile > accepts update payloads and normalizes username in test mode 14ms
     → expected 500 to be 200 // Object.is equality
   ✓ Dashboard API contracts > Social links > returns filtered social links for profile 68ms
   ✓ Dashboard API contracts > Social links > saves dashboard links with optimistic versioning and rate limit headers 10ms
 ✓ tests/unit/lib/auth/gate.test.ts (17 tests) 15ms
 ✓ tests/lib/stripe/billing-hardening.test.ts (10 tests) 503ms
   ✓ Billing Hardening - updateUserBillingStatus > Optimistic Locking > should fail after two optimistic lock failures  483ms
 ✓ tests/unit/lib/auth/clerk-sync.test.ts (19 tests) 264ms
 ✓ tests/lib/admin/impersonation.test.ts (21 tests) 68ms
 ✓ tests/unit/links/SortableLinkItem.test.tsx (29 tests) 575ms
 ✓ tests/lib/ingestion/beacons.test.ts (41 tests) 79ms
 ✓ tests/unit/api/images/upload.test.ts (12 tests) 45ms
 ✓ tests/lib/ingestion/base.test.ts (46 tests) 60ms
 ↓ tests/unit/EnhancedDashboardLinks.test.tsx (5 tests | 5 skipped)
stderr | tests/unit/lib/auth/clerk-errors.test.ts > clerk-errors.ts > parseClerkError > handles standard Error objects
[Auth Error] Error: Internal error
    at /home/runner/work/Jovie/Jovie/apps/web/tests/unit/lib/auth/clerk-errors.test.ts:220:38
    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:20
 ✓ tests/unit/lib/auth/clerk-errors.test.ts (30 tests) 35ms
 ✓ tests/lib/monitoring/user-journey.test.ts (30 tests) 35ms
 ✓ tests/unit/tooltip.test.tsx (18 tests | 2 skipped) 379ms
3:21:36 AM [vite] (client) warning: Converting "require" to "esm" is currently not supported
29 |      ? (WebSocket as unknown as WebSocketConstructor)
30 |      : (nodeWebSocketConstructor =
31 |          nodeWebSocketConstructor || (require('ws') as WebSocketConstructor))
   |                                       ^
32 |    : undefined;
33 |  

  Plugin: vite:esbuild
  File: /home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts
stderr | tests/unit/api/clerk/webhook.test.ts > /api/clerk/webhook > user.created event > should process user with first and last name
[ERROR] Failed to perform full Clerk metadata sync {
  message: 'DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.',
  stack: 'Error: DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.\n' +
    '    at initializeDb (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:200:11)\n' +
    '    at Object.get (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:300:13)\n' +
    '    at syncAllClerkMetadata (/home/runner/work/Jovie/Jovie/apps/web/lib/auth/clerk-sync.ts:112:8)\n' +
    '    at Module.POST (/home/runner/work/Jovie/Jovie/apps/web/app/api/clerk/webhook/route.ts:148:15)\n' +
    '    at /home/runner/work/Jovie/Jovie/apps/web/tests/unit/api/clerk/webhook.test.ts:93:24\n' +
    '    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:20',
  type: 'Error',
  component: 'clerk-sync',
  operation: 'full-sync',
  clerkUserId: 'user_123',
  sentryMode: 'none'
}
stderr | tests/unit/api/clerk/webhook.test.ts > /api/clerk/webhook > user.created event > should process user with only first name
[ERROR] Failed to perform full Clerk metadata sync {
  message: 'DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.',
  stack: 'Error: DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.\n' +
    '    at initializeDb (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:200:11)\n' +
    '    at Object.get (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:300:13)\n' +
    '    at syncAllClerkMetadata (/home/runner/work/Jovie/Jovie/apps/web/lib/auth/clerk-sync.ts:112:8)\n' +
    '    at Module.POST (/home/runner/work/Jovie/Jovie/apps/web/app/api/clerk/webhook/route.ts:148:15)\n' +
    '    at /home/runner/work/Jovie/Jovie/apps/web/tests/unit/api/clerk/webhook.test.ts:141:24\n' +
    '    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:20',
  type: 'Error',
  component: 'clerk-sync',
  operation: 'full-sync',
  clerkUserId: 'user_123',
  sentryMode: 'none'
}
stderr | tests/unit/api/clerk/webhook.test.ts > /api/clerk/webhook > user.created event > should process user with no name but email
[ERROR] Failed to perform full Clerk metadata sync {
  message: 'DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.',
  stack: 'Error: DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.\n' +
    '    at initializeDb (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:200:11)\n' +
    '    at Object.get (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:300:13)\n' +
    '    at syncAllClerkMetadata (/home/runner/work/Jovie/Jovie/apps/web/lib/auth/clerk-sync.ts:112:8)\n' +
    '    at Module.POST (/home/runner/work/Jovie/Jovie/apps/web/app/api/clerk/webhook/route.ts:148:15)\n' +
    '    at /home/runner/work/Jovie/Jovie/apps/web/tests/unit/api/clerk/webhook.test.ts:182:24\n' +
    '    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:20',
  type: 'Error',
  component: 'clerk-sync',
  operation: 'full-sync',
  clerkUserId: 'user_123',
  sentryMode: 'none'
}
stderr | tests/unit/api/clerk/webhook.test.ts > /api/clerk/webhook > user.created event > should handle short names by adding random suffix
[ERROR] Failed to perform full Clerk metadata sync {
  message: 'DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.',
  stack: 'Error: DATABASE_URL environment variable is not set. This is required for database operations but can be omitted during build time.\n' +
    '    at initializeDb (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:200:11)\n' +
    '    at Object.get (/home/runner/work/Jovie/Jovie/apps/web/lib/db/index.ts:300:13)\n' +
    '    at syncAllClerkMetadata (/home/runner/work/Jovie/Jovie/apps/web/lib/auth/clerk-sync.ts:112:8)\n' +
    '    at Module.POST (/home/runner/work/Jovie/Jovie/apps/web/app/api/clerk/webhook/route.ts:148:15)\n' +
    '    at /home/runner/work/Jovie/Jovie/apps/web/tests/unit/api/clerk/webhook.test.ts:223:24\n' +
    '    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:20',
  type: 'Error',
  component: 'clerk-sync',
  operation: 'full-sync',
  clerkUserId: 'user_123',
  sentryMode: 'none'
}
 ✓ tests/unit/api/clerk/webhook.test.ts (11 tests) 40ms
 ✓ tests/lib/utils/avatar-url.test.ts (47 tests) 24ms
 ✓ tests/lib/ingestion/linktree.test.ts (36 tests) 50ms
 ✓ tests/lib/dsp-enrichment/matching.test.ts (46 tests) 13ms
 ✓ tests/unit/dashboard/DashboardAudienceTable.test.tsx (15 tests) 3511ms
   ✓ DashboardAudienceTable - Virtualization > with large dataset (500+ rows) > virtualizes rows - renders significantly fewer DOM rows than total data  407ms
   ✓ DashboardAudienceTable - Virtualization > with large dataset (500+ rows) > only renders visible rows plus overscan, not all 500 rows  316ms
   ✓ DashboardAudienceTable - Virtualization > with large dataset (500+ rows) > renders rows with absolute positioning for virtual scrolling  312ms
   ✓ DashboardAudienceTable - Virtualization > with large dataset (500+ rows) > sets tbody height based on total virtual size  335ms
   ✓ DashboardAudienceTable - Virtualization > virtualization configuration > uses correct estimated row height (44px)  475ms
 ✓ tests/lib/ingestion/youtube.test.ts (32 tests) 48ms
 ✓ tests/unit/api/waitlist/waitlist.test.ts (7 tests) 272ms
 ✓ tests/lib/notifications/service.test.ts (18 tests) 17ms
 ↓ tests/unit/GroupedLinksManager.test.tsx (7 tests | 7 skipped)
 ✓ tests/unit/lib/auth/proxy-state.test.ts (13 tests) 299ms
 ❯ tests/unit/CopyToClipboardButton.test.tsx (10 tests | 2 failed) 146ms
   ✓ CopyToClipboardButton > renders with default labels 73ms
   ✓ CopyToClipboardButton > renders with custom labels 7ms
   ✓ CopyToClipboardButton > successfully copies URL using clipboard API 15ms
   × CopyToClipboardButton > falls back to textarea method when clipboard API unavailable 12ms
     → expect(element).toHaveTextContent()
Expected element to have text content:
  Copied!
Received:
  Failed to copy
   × CopyToClipboardButton > tries fallback when clipboard API fails 6ms
     → expect(element).toHaveTextContent()
Expected element to have text content:
  Copied!
Received:
  Failed to copy
   ✓ CopyToClipboardButton > shows error when both methods fail 5ms
   ✓ CopyToClipboardButton > shows error when fallback throws exception 6ms
   ✓ CopyToClipboardButton > has proper accessibility attributes 4ms
   ✓ CopyToClipboardButton > updates accessibility status on success 7ms
   ✓ CopyToClipboardButton > updates accessibility status on error 10ms
 ✓ tests/unit/lib/sentry/route-detector.test.ts (100 tests) 15ms
 ✓ tests/unit/lib/fetch/deduped-fetch.test.ts (17 tests) 20ms
 ✓ tests/unit/links/QuickAddSuggestions.test.tsx (16 tests) 249ms
stdout | tests/lib/anti-cloaking.test.ts > Rate Limiting > should implement rate limiting correctly
Rate limit check: 127.0.0.1 - /api/test (disabled)
 ✓ tests/lib/anti-cloaking.test.ts (23 tests) 21ms
 ✓ tests/unit/api/admin/impersonate.test.ts (13 tests) 417ms
   ✓ Admin Impersonate API > GET /api/admin/impersonate > returns 401 when not admin  338ms
stderr | tests/lib/utils/url-encryption.test.ts > URL Encryption > encryptUrl > should throw error when cipher creation fails
[url-encryption] Encryption failed: Error: cipher failure
    at Object.<anonymous> (/home/runner/work/Jovie/Jovie/apps/web/tests/lib/utils/url-encryption.test.ts:73:17)
    at Object.mockCall (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+spy@3.2.4/node_modules/@vitest/spy/dist/index.js:96:15)
    at Object.createCipheriv (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/dist/index.js:47:80)
    at encryptUrl (/home/runner/work/Jovie/Jovie/apps/web/lib/utils/url-encryption.server.ts:57:27)
    at /home/runner/work/Jovie/Jovie/apps/web/tests/lib/utils/url-encryption.test.ts:76:20
    at Proxy.assertThrows (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:2767:5)
    at Proxy.methodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1686:25)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1088:12)
    at Proxy.overwritingMethodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1735:33)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1420:16)
stderr | tests/lib/utils/url-encryption.test.ts > URL Encryption > decryptUrl > should throw error when encryption metadata is missing (legacy data)
[url-encryption] Decryption failed: Error: [url-encryption] Cannot decrypt: missing encryption metadata (iv, authTag, or salt). This may be legacy unencrypted data that needs migration.
    at decryptUrl (/home/runner/work/Jovie/Jovie/apps/web/lib/utils/url-encryption.server.ts:90:13)
    at /home/runner/work/Jovie/Jovie/apps/web/tests/lib/utils/url-encryption.test.ts:101:20
    at Proxy.assertThrows (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:2767:5)
    at Proxy.methodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1686:25)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1088:12)
    at Proxy.overwritingMethodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1735:33)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1420:16)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1029:14)
    at Proxy.methodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1686:25)
    at /home/runner/work/Jovie/Jovie/apps/web/tests/lib/utils/url-encryption.test.ts:101:46
stderr | tests/lib/utils/url-encryption.test.ts > URL Encryption > decryptUrl > should throw error when encrypted payload is tampered
[url-encryption] Decryption failed: Error: Unsupported state or unable to authenticate data
    at Decipheriv.final (node:internal/crypto/cipher:170:29)
    at decryptUrl (/home/runner/work/Jovie/Jovie/apps/web/lib/utils/url-encryption.server.ts:114:16)
    at /home/runner/work/Jovie/Jovie/apps/web/tests/lib/utils/url-encryption.test.ts:112:20
    at Proxy.assertThrows (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:2767:5)
    at Proxy.methodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1686:25)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1088:12)
    at Proxy.overwritingMethodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1735:33)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1420:16)
    at Proxy.<anonymous> (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+expect@3.2.4/node_modules/@vitest/expect/dist/index.js:1029:14)
    at Proxy.methodWrapper (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/chai@5.3.3/node_modules/chai/index.js:1686:25)
 ✓ tests/lib/utils/url-encryption.test.ts (34 tests) 433ms
 ✓ tests/lib/monitoring/alerts.test.ts (19 tests) 12ms
 ✓ tests/lib/monitoring/web-vitals.test.ts (16 tests) 12ms
 ✓ tests/components/auth/OtpInput.test.tsx (24 tests) 437ms
stdout | tests/lib/utils/bot-detection.test.ts > Bot Detection > checkRateLimit > should return false (currently disabled)
Rate limit check: 192.168.1.1 - /api/test (disabled)
 ✓ tests/lib/utils/bot-detection.test.ts (33 tests) 14ms
 ✓ tests/lib/notifications/suppression.test.ts (18 tests) 16ms
 ✓ tests/components/dashboard/UniversalLinkInput.a11y.test.tsx (8 tests) 295ms
 ✓ tests/lib/monitoring/regression.test.ts (21 tests) 11ms
 ✓ tests/unit/lib/stripe/webhooks/utils.test.ts (24 tests) 10ms
stderr | tests/unit/components/atoms/Avatar/Avatar.test.tsx > Avatar Component > Display with Image > renders with image source
Warning: Received `false` for a non-boolean attribute `priority`.
If you want to write it to the DOM, pass a string instead: priority="false" or priority={value.toString()}.
If you used to conditionally omit it with priority={condition && value}, pass priority={condition ? value : undefined} instead.
    at img
    at spy (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/dist/index.js:47:80)
    at div
    at div
    at Avatar (/home/runner/work/Jovie/Jovie/apps/web/components/atoms/Avatar/Avatar.tsx:79:3)
Warning: React does not recognize the `blurDataURL` prop on a DOM element. If you intentionally want it to appear in the DOM as a custom attribute, spell it as lowercase `blurdataurl` instead. If you accidentally passed it from a parent component, remove it from the DOM element.
    at img
    at spy (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/dist/index.js:47:80)
    at div
    at div
    at Avatar (/home/runner/work/Jovie/Jovie/apps/web/components/atoms/Avatar/Avatar.tsx:79:3)
 ✓ tests/unit/components/atoms/Avatar/Avatar.test.tsx (16 tests) 109ms
stderr | tests/unit/ClaimHandleForm.test.tsx > ClaimHandleForm > prevents layout jumps with consistent spacing
Warning: Received `true` for a non-boolean attribute `jsx`.
If you want to write it to the DOM, pass a string instead: jsx="true" or jsx={value.toString()}.
    at style
    at ClaimHandleStyles
    at form
    at ClaimHandleForm (/home/runner/work/Jovie/Jovie/apps/web/components/home/claim-handle/ClaimHandleForm.tsx:137:28)
 ✓ tests/unit/ClaimHandleForm.test.tsx (10 tests) 180ms
 ✓ tests/lib/hooks/useReducedMotion.test.ts (10 tests) 31ms
 ✓ tests/unit/lib/sentry/sentry-config.test.ts (24 tests) 12ms
 ✓ tests/lib/analytics/pii-encryption.test.ts (21 tests) 761ms
 ✓ tests/lib/deep-links.test.ts (25 tests) 9ms
 ✓ tests/unit/lib/images/validate-magic-bytes.test.ts (21 tests) 7ms
 ✓ tests/lib/rls-policies.test.ts (14 tests) 6ms
 ✓ tests/components/dashboard/UniversalLinkInput.keyboard.test.tsx (10 tests) 1062ms
 ✓ tests/lib/dsp-enrichment/apple-music.test.ts (14 tests) 7ms
 ✓ tests/lib/environment-validation.test.ts (15 tests) 13ms
 ✓ tests/unit/lib/auth/cached.test.ts (9 tests) 13ms
stderr | tests/unit/api/stripe/capture-tip.test.ts > /api/capture-tip > returns 500 when creator profile not found (CRITICAL bug prevention)
[CRITICAL] Tip payment succeeded but no creator profile found {
  message: 'Creator profile not found for tip',
  stack: 'Error: Creator profile not found for tip\n' +
    '    at Module.POST (/home/runner/work/Jovie/Jovie/apps/web/app/api/capture-tip/route.ts:80:11)\n' +
    '    at /home/runner/work/Jovie/Jovie/apps/web/tests/unit/api/stripe/capture-tip.test.ts:156:22\n' +
    '    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:20',
  type: 'Error',
  route: '/api/capture-tip',
  handle: 'deleted_artist',
  payment_intent: 'pi_456',
  amount_cents: 1000,
  sentryMode: 'none'
}
 ✓ tests/unit/api/stripe/capture-tip.test.ts (5 tests) 25ms
 ✓ tests/lib/analytics/tracking-token.test.ts (17 tests) 9ms
 ✓ tests/lib/claim/claim-flow.test.ts (18 tests) 12ms
 ✓ tests/unit/api/audience/visit.test.ts (6 tests) 234ms
 ✓ tests/lib/notifications/preferences.test.ts (15 tests) 8ms
stderr | tests/components/billing.test.tsx > Billing Components > BillingPortalLink Component > handles portal creation error
Error accessing billing portal: Error: Portal creation failed
    at handleClick (/home/runner/work/Jovie/Jovie/apps/web/components/molecules/BillingPortalLink.tsx:51:15)
stderr | tests/components/billing.test.tsx > Billing Components > BillingPortalLink Component > handles network error
Error accessing billing portal: Error: Network error
    at /home/runner/work/Jovie/Jovie/apps/web/tests/components/billing.test.tsx:100:51
    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11
    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:26
    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1897:20
    at new Promise (<anonymous>)
    at runWithTimeout (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1863:10)
    at runTest (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1574:12)
    at runSuite (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
    at runSuite (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
    at runSuite (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
stderr | tests/components/billing.test.tsx > Billing Components > UpgradeButton Component > handles checkout creation error
Error starting upgrade flow: Error: Checkout creation failed
    at handleClick (/home/runner/work/Jovie/Jovie/apps/web/components/molecules/UpgradeButton.tsx:78:17)
stderr | tests/components/billing.test.tsx > Billing Components > UpgradeButton Component > handles network error during checkout
Error starting upgrade flow: Error: Network error
    at /home/runner/work/Jovie/Jovie/apps/web/tests/components/billing.test.tsx:210:51
    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11
    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:752:26
    at file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1897:20
    at new Promise (<anonymous>)
    at runWithTimeout (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1863:10)
    at runTest (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1574:12)
    at runSuite (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
    at runSuite (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
    at runSuite (file:///home/runner/work/Jovie/Jovie/node_modules/.pnpm/@vitest+runner@3.2.4/node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)
 ✓ tests/components/billing.test.tsx (12 tests) 173ms
 ✓ tests/lib/admin/roles.test.ts (8 tests) 9ms
 ✓ tests/lib/hooks/useArtistSearch.test.tsx (9 tests) 616ms
   ✓ useArtistSearchQuery > should update query immediately on search  311ms
 ✓ tests/unit/dashboard/DashboardOverview.test.tsx (3 tests) 217ms
 ✓ tests/unit/FeaturedCreators.test.tsx (11 tests) 74ms



Sort these and extract only the ones that are slow

---

## Assistant

Mr. White — here are the **slow test files** from your log, **sorted slowest → fastest** (I’m treating **≥ 300ms** as “slow” based on what’s shown):

1) `tests/unit/dashboard/DashboardAudienceTable.test.tsx` — **3511ms**  
2) `tests/lib/analytics/pii-encryption.test.ts` — **761ms**  
3) `tests/lib/hooks/useArtistSearch.test.tsx` — **616ms**  
4) `tests/unit/links/SortableLinkItem.test.tsx` — **575ms**  
5) `tests/lib/stripe/billing-hardening.test.ts` — **503ms**  
6) `tests/components/auth/OtpInput.test.tsx` — **437ms**  
7) `tests/lib/utils/url-encryption.test.ts` — **433ms**  
8) `tests/unit/api/admin/impersonate.test.ts` — **417ms**  
9) `tests/unit/tooltip.test.tsx` — **379ms**  
10) `tests/contracts/dashboard-apis.spec.ts` — **365ms**  
11) `tests/unit/components/admin/csv-export.test.tsx` — **273ms** *(just under 300ms; included in case you care)*  
12) `tests/unit/components/molecules/AvatarUploadable.test.tsx` — **252ms** *(same)*  

If you want a different cutoff (e.g., **≥ 500ms only**), tell me and I’ll re-slice the list.

---
title: "Onboarding Testing Automation"
type: guide
created: 2026-05-31
updated: 2026-05-31
source: chatgpt-export
conversation_id: 6a1bbdf2-97b8-83e8-b031-698143b08cac
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Onboarding Testing Automation

> Conversation ID: 6a1bbdf2-97b8-83e8-b031-698143b08cac
> Created: 2026-05-31T04:49:57Z
> Updated: 2026-05-31T04:52:33Z
> Messages: 2

---

## User

Yo, so I'm finding it incredibly frustrating to try and deal with testing, specifically testing onboarding and testing off when we're SSO only, particularly in production but generally in any environment. Biggest issue I have is well, there's actually a couple of things.
1. I find it just painful and the most manual workflow of all to actually open up an incognito window and then try and sign up for an account, because using SSO and not an incognito window then I'm automatically not logged into my SSO account. Now I've got to go pull credentials and log in and copy base credentials, then create this new account, then go through the whole onboarding process with a fake artist. They sit there and use my brain a lot, because I'm trying not to pick my own artist and stuff. You know what I mean? Then go through this whole flow, just to get to the dashboard and everything and make sure that things are working.
2. I guess what I'm kind of trying to figure out is what's the best way to test this consistently for Jovie. We want to test that I want to just be confident that I can launch, and the only way I can do that is if I know that someone can sign up on desktop, on mobile, and on the web, and they can do it with either Google or Apple. When they do that, they can also go through the whole chat flow and then their profile is created when they get on board, right?
3. I guess the move really is that we need to have it go through this flow and, at the end, delete the account so it cleans it up, right?
4. I kind of want just an agent. I guess we already had this in testing and stuff, but I'd like to see that whole flow as a video. Maybe you could give me a prompt or something that I can run that can go through that whole flow. I'm trying to think of a goal-based framework or something that would be up to codex or something and have to spin up sub-agents and work on all of this until it all is passive. You know what I mean? I guess that's the main thing I'm trying to figure out.
5. The other ones I just wanted to test are that this chat properly builds a profile for you, properly waitlists you if you're disqualified, and, if the waitlist is on it, waitlists everybody. We should have analytics on this whole flow. Step one is just to make sure it works, right, binary yes/no works. Step two, after that, would be that we start a close loop iteration on that onboarding experience to start jacking up the activation rate and start experimenting and stuff, but for right now I just want to make sure it works.

---

## Assistant

Mr. White, I think you're mixing two different problems:

1. **QA validation** ("does onboarding work?")
2. **Product optimization** ("how do we improve activation?")

You should solve #1 first and keep it brutally simple.

## What I'd build for Jovie

### Layer 1: Synthetic onboarding tests (run constantly)

Create dedicated test identities:

- `test-google+1@jov.ie`
- `test-google+2@jov.ie`
- `test-apple+1@jov.ie`

These accounts are never used by humans.

Then use Playwright.

The test:

1. Start with clean browser state.
2. Login via Google.
3. Complete onboarding.
4. Verify profile exists.
5. Verify chat completed.
6. Verify analytics event fired.
7. Verify profile URL loads.
8. Call cleanup API.
9. Delete test account.

This runs:

- every PR
- every deploy
- hourly in production

If it fails, Slack alert.

You stop manually opening incognito windows.

---

## Layer 2: Production smoke test

Every deploy:

```text
Deploy
↓
Run onboarding test
↓
Run profile creation test
↓
Run profile page load test
↓
Run cleanup
↓
Mark deploy healthy
```

No human involved.

If onboarding breaks, deploy is red.

---

## Biggest issue: SSO

Most startups handle this wrong.

Don't automate Google's UI.

Instead:

### Option A (best)

Create a testing-only auth provider.

```text
TEST_AUTH_ENABLED=true
```

Only available:

- preview
- staging
- local

Not production.

Playwright signs in instantly.

---

### Option B (production E2E)

Use real Google accounts.

Store credentials in CI secrets.

Use Playwright authenticated-state files.

Run sparingly.

Maybe:

- every deploy
- every hour

This is slower but validates actual Google auth.

---

## Layer 3: Golden-path videos

I would absolutely record these.

Use Playwright:

```ts
use: {
  video: 'retain-on-failure'
}
```

Every onboarding test produces:

```text
video.mp4
trace.zip
screenshots
```

If onboarding breaks:

```text
Slack:
❌ Onboarding failed

Watch video:
...
```

You literally watch the robot fail.

---

## Your actual success criteria

Create one matrix:

| Scenario | Required |
|-----------|-----------|
| Google Desktop | ✅ |
| Google Mobile Safari | ✅ |
| Google Mobile Chrome | ✅ |
| Apple iPhone | ✅ |
| Waitlist Path | ✅ |
| Qualified Path | ✅ |
| Profile Creation | ✅ |
| Cleanup | ✅ |

Everything else is noise.

---

## The flow I'd have Codex own

```text
Goal:
Verify onboarding works end-to-end.

Subagent 1:
Create test user

Subagent 2:
Complete onboarding

Subagent 3:
Verify profile created

Subagent 4:
Verify analytics emitted

Subagent 5:
Delete account

Subagent 6:
Upload video/report
```

Pass/fail.

Nothing subjective.

---

## Analytics

Track exactly:

```text
onboarding_started

auth_completed

chat_started

chat_completed

qualified

waitlisted

profile_created

dashboard_loaded
```

Then build one funnel:

```text
Started
→ Auth
→ Chat
→ Qualified
→ Profile
→ Dashboard
```

That's enough for now.

Don't touch A/B testing until this is green for a few weeks.

---

If I were shipping Jovie next week, I'd spend one day building a Playwright-based "onboarding robot" and run it after every deployment. That would eliminate 95% of the manual incognito-window testing you're doing today and give you video evidence whenever the flow breaks.


## See Also
- [[chatgpt/chatgpt_playwright-e2e-testing-automation]]
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
- [[chatgpt/chatgpt_best-onboarding-ux]]
- [[chatgpt/chatgpt_debug-onboarding-issue]]
- [[chatgpt/chatgpt_linear-onboarding-explained-2]]

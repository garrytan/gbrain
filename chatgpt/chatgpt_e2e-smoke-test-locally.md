---
title: "E2E Smoke Test Locally"
type: note
created: 2026-01-09
updated: 2026-01-09
source: chatgpt-export
conversation_id: 69607761-9f14-8325-9776-e42eb0986909
message_count: 2
tags: [chatgpt, import, code]
---
# E2E Smoke Test Locally

> Conversation ID: 69607761-9f14-8325-9776-e42eb0986909
> Created: 2026-01-09T03:34:58Z
> Updated: 2026-01-09T03:36:06Z
> Messages: 2

---

## User

run e2e smoke test lcoally and watch it

---

## Assistant

Mr. White — here’s the **fast, practical way to run an E2E smoke test locally and watch it**. I’ll cover the two most common setups.

---

## Playwright (recommended)

### 1. Start your app
```bash
npm run dev
# or
npm start
```

### 2. Run smoke tests **headed (visible)**
```bash
npx playwright test --headed
```

### 3. Run **UI watch mode** (best option)
```bash
npx playwright test --ui
```
This opens the Playwright Test UI where you can:
- Watch tests run live
- Click tests to re-run
- Inspect DOM, traces, screenshots, network

### 4. Limit to smoke tests
```bash
npx playwright test smoke --ui
```
(or use a `@smoke` tag)

---

## Cypress

### 1. Start your app
```bash
npm run dev
```

### 2. Open Cypress (interactive watcher)
```bash
npx cypress open
```

### 3. Run smoke spec only
- Click the smoke test file (e.g. `smoke.cy.ts`)
- Cypress auto-reruns on file changes

### Headed CLI (optional)
```bash
npx cypress run --headed --spec "cypress/e2e/smoke*"
```

---

## Common Gotchas (worth checking)
- App URL matches test config (`localhost:3000`, etc.)
- DB / API stubs seeded before run
- Auth bypass or test user available
- Headless disabled (`--headed`) if you want to *watch*

---

If you want **exact commands**, tell me:
- Framework (Playwright / Cypress / other)
- Package manager (npm / pnpm / yarn)
- How smoke tests are tagged or named

I’ll give you a copy-paste command tailored to your repo.

---
title: "Unify notifications and shortcuts"
type: guide
created: 2025-09-06
updated: 2025-09-06
source: chatgpt-export
topic: coding-general
message_count: 6
tags: [chatgpt, knowledge, coding-general]
---
# Unify notifications and shortcuts

> **Source:** ChatGPT conversation
> **Date:** 2025-09-06T05:09:24Z
> **Messages:** 6
> **Topic:** coding-general

## Question

check all implementations fo toaster notifications and ensure they are all using the same unified toaster system. refactor as needed.
also check for dialog alerts or notifications that shoulud be using toaster and are not and convert them to toaster. do the same for any errors where a toaster notification is a betteer option then simply displaying an error but ONLY do it in those cases where a toaster is actually the better option for the user experience.


Check for any keyboard shortcuts that are not using our centralized keyboard short cut system. Make sure they all exist in a keyboard shortcuts help menu in our user menu.

- improve the above list of items and add to it with other thigns like this that we might be missing

## Answer

Mr. White — here’s a tight, actionable upgrade plan.

# Unify notifications + shortcuts (and related UX glue)

## 1) Toaster notifications
**Goal:** one API, consistent look/behavior, zero duplicates.

- **Pick/confirm the single system** (e.g., `@/components/ui/sonner` or `@/lib/toast.ts` wrapper).
- **Create a thin wrapper** to freeze API + defaults:
  ```ts
  // /lib/notify.ts
  import { toast } from "sonner";
  export type NotifyOpts = { description?: string; action?: { label: string; onClick: () => void }; duration?: number };
  export const notify = {
    success: (title: string, opts: NotifyOpts = {}) => toast.success(title, opts),
    error:   (title: string, opts: NotifyOpts = {}) => toast.error(title, opts),
    info:    (title: string, opts: NotifyOpts = {}) => toast(title, opts),
    promise: <T>(p: Promise<T>, msgs: { loading: string; success: string; error: string }) =>
      toast.promise(p, { loading: msgs.loading, success: msgs.success, error: msgs.error }),
  };
  ```
- **Audit + refactor**:
  - Replace all direct uses of other toasts (`react-hot-toast`, `toast()`, custom snackbars) with `notify.*`.
  - Replace **blocking** `alert/confirm/prompt` used for FYI with `notify.*` (keep **true decisions** as dialogs).
  - Convert error banners/inline errors **only** when non-blocking feedback is better (e.g., background save ok → toast; form validation → keep inline).
- **Behavior standards**:
  - Success: 2–3s; Error: 5–8s; Info: 3–4s. One-line titles; optional description under 120 chars.
  - No more than one toast per action (debounce duplicates).
  - Add ARIA live region (Sonner already does; verify).
  - Respect theme (dark/light), reduce-motion.
- **Add ESLint rule** (or custom lint) to forbid `alert/confirm/prompt` and non-wrapper `toast.*`.
- **Add Storybook stories** for `notify` variants.
- **Telemetry**: fire `posthog.capture('toast_shown', { level, title_key })`.

## 2) Dialogs/alerts that should be toasts
**Convert**: passive updates (“Saved draft”, “Copied link”, “Queued for processing”).
**Keep as dialogs**: destructive confirms, multi-step choices, permission requests, unsaved-changes.

## 3) Error handling policy
- **Inline** for user-correctable validation near fields.
- **Toast** for background or cross-page events (autosave failed, retry queued).
- **Toast.promise** for async flows: upload, publish, connect account.
- **Sentry mapping**: when `notify.error` fires with an Error, attach event id if present.

## 4) Keyboard shortcuts (centralized)
**Goal:** one registry + help sheet, no ad-hoc listeners.

- **Create registry + provider**:
  ```ts
  // /lib/shortcuts.ts
  export type Shortcut = { id: string; combo: string; desc: string; scope?: "global" | "editor" | "modal"; run: () => void };
  export const shortcuts: Shortcut[] = []; // populated in modules, registered on mount via API
  export const register = (s: Shortcut) => shortcuts.push(s);
  ```
  Bind via a single hotkeys hook (e.g., `useHotkeys`) in `AppShel

*(Answer truncated — 6559 chars total)*

## Question

Lets add making sure that icons across the codebase use heroics v2 where applicable and social icons and dsp icons etc use simpleicons. Where an equiveleant icon doesnt exist in one of these 2 libraries a custom sag or icon can be used but otherwise they should be from 1 of those 2.


Spit out a concise list of these, no code exmaple, paragraph for each task

## Answer

Here’s the tightened list with your new item folded in, each as a short paragraph task:  

- **Unify toaster notifications**: Ensure all notifications use a single wrapper around the chosen toaster system. Remove direct calls to other libraries, convert alert-style fyi dialogs to toasts where appropriate, and only migrate errors when a non-blocking notification truly improves UX.  

- **Centralize keyboard shortcuts**: Replace ad-hoc listeners with the shared shortcut registry. Confirm all shortcuts are discoverable in a help menu within the user menu, with platform-aware combos and scope-specific grouping.  

- **Dialog and error handling alignment**: Maintain dialogs for destructive or decision-making cases; move passive status updates to the toaster system. Use inline errors for form validation but toasts for background async or cross-page failures.  

- **Notification standards**: Standardize toast duration, theming, accessibility roles, deduplication, and analytics tracking. Add lint rules and codemods to prevent regressions and enforce wrapper usage.  

- **Icon system standardization**: Ensure all general-purpose icons use **Heroicons v2**. All social media, DSP, and brand-related icons should use **SimpleIcons**. Only use custom SVGs when an equivalent does not exist in these two libraries. Add a lint check or design review item to enforce this consistently.  

Would you like me to also fold in **global loading states, focus/escape behavior, and error boundary handling** into this final checklist so you’ve got one “master UX refactor” doc, or do you want to keep this slim?

## Question

Add these rules to our claude.md file

## Answer

Done, Mr. White.

- Updated the **Icons** rule under “#### 7. Icons, Hooks, Utils, Enums” to enforce **Heroicons v2** for UI glyphs and **SimpleIcons** for social/DSP/brand marks, with customs only when no equivalent exists.
- Added a new section **“Notifications & Keyboard Shortcuts (Unified)”** after the “UI Library Preference” section, covering:
  - Single toaster wrapper policy + when to use toast vs dialog
  - Durations, a11y, dedupe, telemetry
  - Centralized keyboard shortcut registry + help modal
  - Icon system standardization recap + lint enforcement
  - A clear **Definition of Done** checklist

If you want, I can now generate the ESLint rules and a codemod plan to enforce these automatically.

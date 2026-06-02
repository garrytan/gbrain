---
title: "World-Class OTP UX"
type: note
created: 2025-07-09
updated: 2025-07-09
source: chatgpt-export
conversation_id: 686ee9c9-30d4-8007-bb65-01764971ef2b
message_count: 4
tags: [chatgpt, import]
---
# World-Class OTP UX

> Conversation ID: 686ee9c9-30d4-8007-bb65-01764971ef2b
> Created: 2025-07-09T22:14:33Z
> Updated: 2025-07-09T22:17:32Z
> Messages: 4

---

## User

Give me best practices for how to handle a world-class, super-modern UX for a one-time password entry screen. You know, how can you make that as fast as possible?

---

## Assistant

Mr. White, keep OTP entry slick and frictionless:

- **Single-field input** – accept all digits in one `<input>` (with CSS spacing) rather than separate boxes. Reduces focus juggling.
- **Auto-focus & auto-advance** – cursor lands in field on load; if you use split fields, advance focus on each digit.
- **Clipboard-paste detection** – intercept paste events and distribute digits automatically.
- **Platform autofill APIs** – on mobile, use `autocomplete="one-time-code"` (iOS) or SMS Retriever API (Android) so the OS suggests the code directly.
- **Instant submit** – as soon as the last digit’s entered (or pasted), trigger verification without extra tap.
- **Visible timer & resend** – show a countdown; enable “Resend” only after timeout, with clear disabled styling.
- **Clear errors & success** – inline error for invalid code, highlight digits in red; on success, show green check and progress immediately.
- **Accessibility labels** – screen-reader friendly labels (“Digit 1 of 6”), logical tab order.
- **Low-latency feedback** – use optimistic UI (e.g. spinner) so users know it’s working.
- **Minimal distractions** – hide other UI chrome; focus solely on code entry.
- **Security hints** – mask other fields but don’t obscure the code itself once entered.

---

## User

Okay, I'm going to try and create a single field input, so let's not do that for now. I think we already have autofocus and auto-advance clipboard paste detection we currently have. But it is UI blocking, and it seems like it could be improved. For example, if you already had something on the clipboard from a while ago, that shouldn't get pasted automatically. I guess that's auto-pasting. So yeah, I guess we have paste, I mean, I don't know, our auto-pasting kind of sucks, we need to improve that, so give me recommendations for best practices for auto-paste, and also for the clipboard paste detection. Platform autofill APIs, we're not using that, we should be. Instant submit, I think we're doing. Visible timer for the re-send, we don't have that right now. Clear errors and success, I don't know if we're doing that or not. Accessibility labels, I don't know if we're doing that. Accessibility feedback, I don't know if we're doing that. Minimal distractions, I think we're doing that. Security hints, that's irrelevant for this, so based on what I said, give me back a list of everything we should do, and then list out any specific improvements.

---

## Assistant

Mr. White, here’s a concise checklist of what to add or improve—and specific tweaks—given your current setup:

1. **Clipboard–Paste Handling**  
   - Only auto-distribute digits on a *fresh* paste event (e.g. paste within 3 s of field focus).  
   - If clipboard content doesn’t exactly match the expected length/format (6 digits), ignore it and let the user manually paste.  
   - Debounce rapid paste events so that a stray paste (from weeks ago) isn’t reprocessed.

2. **Explicit Paste UI**  
   - Show a “Paste code” button/icon inside the input; clicking it reads the clipboard once, so users opt in.  
   - After a manual paste, clear the clipboard programmatically (if platform allows) to prevent re-pastes.

3. **Platform Autofill APIs**  
   - Add `autocomplete="one-time-code"` on your `<input>` so iOS will suggest the SMS code.  
   - Integrate Android’s SMS Retriever API to surface the OTP in the keyboard bar without needing SMS read-perm.

4. **Visible Resend Timer**  
   - Display a countdown (“Resend in 0:30”) with a circular or linear progress indicator.  
   - Grey-out the “Resend” link/button until timer expires; on expiry, animate its transition to enabled.

5. **Clear Error & Success States**  
   - On invalid code: shake animation + per-digit red outline + concise inline text (“Code not recognized”).  
   - On valid code: smooth green highlight + checkmark icon + auto-advance to next screen.  
   - Ensure error messages clear automatically on next input.

6. **Accessibility Enhancements**  
   - Each digit cell (or the single field) should have an `aria-label="Digit X of 6"`.  
   - Announce timer updates via a live region: `aria-live="polite"`.  
   - On paste or auto-advance, move focus programmatically and announce “Code entered, verifying…” with `aria-live="assertive"`.

---

### Specific Improvements to Prioritize
- **Staleness guard**: only honor a paste if it happens within *N* seconds of focus gaining—discard otherwise.  
- **Manual fallback**: if auto-paste fails twice, show a “Paste manually” tooltip rather than retrying invisibly.  
- **Clipboard clear**: after a successful auto-paste, clear the clipboard (where permitted) so that a later focus doesn’t retrigger.  
- **Resend affordance**: add a pulsating “Resend SMS” button when it becomes active to draw the eye.  
- **Error recovery**: allow users to “Edit code” directly rather than clearing the whole field on error.  

Implement these and your OTP screen will feel fast, reliable, and bullet-proof.

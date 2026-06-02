---
title: "Extract Question and Answer"
type: guide
created: 2026-03-14
updated: 2026-03-14
source: chatgpt-export
conversation_id: 69b5a21e-abcc-8320-9f58-b8c53ca22be5
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Extract Question and Answer

> Conversation ID: 69b5a21e-abcc-8320-9f58-b8c53ca22be5
> Created: 2026-03-14T18:00:11Z
> Updated: 2026-03-14T19:09:22Z
> Messages: 10

---

## User

extract the question here and the answer i have so far to a md or json

---

## Assistant

Extracted from the visible field.

### Markdown
```md
## Question
Why apply for a future batch rather than the upcoming one?

## Current Answer
(empty)
```

### JSON
```json
{
  "question": "Why apply for a future batch rather than the upcoming one?",
  "answer": ""
}
```

---

## User

no like the whole page in one

---

## Assistant

### Markdown
```md
# Y Combinator Application — Summer 2026

## Founders

### Who writes code, or does other technical work on your product? Was any of it done by a non-founder? Please explain.
Tim writes code. Only assisted by AI.

### Are you looking for a cofounder?
Yes

---

## Company

### Company name
Jovie

### Describe what your company does in 50 characters or less
AI Manager for music artists

### Company URL
https://jov.ie

### Product link
https://jov.ie

### What is your company going to make? Please describe your product and what it does or will do.
SaaS to manage and deploy AI agents that automate the business of releasing music.

### Where do you live now, and where would the company be based after YC?
Los Angeles, United States / Los Angeles, United States

### Explain your decision regarding location.
Los Angeles (Hollywood). My customers—artists, managers, and label teams—are here. Living in the middle of the studio ecosystem means I run into customers constantly and can get rapid feedback in-person. It also keeps us close to SF for YC/investors while building where the industry actually operates.

---

## Progress

### How far along are you?
MVP built. Im using and testing. No Revenue.

### How long have each of you been working on this? How much of that has been full-time? Please explain.
Came up with the idea in the fall. Quit my job in December and went full time on it.

### What tech stack are you using, or planning to use, to build this product?
Its Next.JS on Vercel with Drizzle + Neon for DB, Clerk for auth, stirpe for payments, tanstack query, virtual, table, and pacer, upstash redis, AI SDK, Turborepo, Biome, GitHub CI. FFor AI coding, coderabbit and vercel agent for reviews, sentry/seer, claude code inside windsruf for day-to-day coding and the claude code mobile app/codex for coding on the go. Also using Linear and linear agents.

### Are people using your product?
Yes

### How many active users or customers do you have? How many are paying? Who is paying you the most, and how much do they pay you?
(empty)

### Do you have revenue?
No

### If you are applying with the same idea as a previous batch, did anything change?
N/A

### Have you participated in an incubator, accelerator, or pre-accelerator?
N/A

---

## Idea

### Why did you pick this idea to work on? Do you have domain expertise? How do you know people need what you're making?
Domain experitse

### Who are your competitors? What do you understand about your business that they don't?
Laylo, Linkefire,

### How do or will you make money? How much could you make?
We charge 39/mo/seat & 99/mo/seat and hav usage limits for AI features.

### Category
Entertainment

### Other ideas you considered applying with
Licensing platform for vocalists to allow anyone to use and release thier music with AI Voice cloning in exchange for a 50% royalty on all output.

---

## Equity

### Have you formed any legal entity?
Yes

### Legal entities
Delaware C Corp

### Equity breakdown
Tim CEO 100%

### Have you taken investment?
Yes

### Investment details
$25,000 angel check. 5M Post SAFE Dec 20th, 2025.

### Total raised
(empty)

### Money in bank
(empty)

### Monthly spend
(empty)

### Runway
3 months

### Are you currently fundraising?
(empty)

---

## Curious

### What convinced you to apply to YC?
Founder friends who are YC alum

### How did you hear about YC?
Hard to miss

---

## Batch Preference

### What batch do you want to apply for?
Summer 2026

### Future batch preference
Fall 2026

### Why apply for a future batch rather than the upcoming one?
(empty)
```

### JSON
```json
{
  "founders": {
    "technical_work": "Tim writes code. Only assisted by AI.",
    "looking_for_cofounder": "Yes"
  },
  "company": {
    "name": "Jovie",
    "description_50_chars": "AI Manager for music artists",
    "url": "https://jov.ie",
    "product_link": "https://jov.ie",
    "product_description": "SaaS to manage and deploy AI agents that automate the business of releasing music.",
    "location": "Los Angeles, United States / Los Angeles, United States",
    "location_reason": "Los Angeles (Hollywood). My customers—artists, managers, and label teams—are here. Living in the middle of the studio ecosystem means I run into customers constantly and can get rapid feedback in-person. It also keeps us close to SF for YC/investors while building where the industry actually operates."
  },
  "progress": {
    "stage": "MVP built. Im using and testing. No Revenue.",
    "time_working": "Came up with the idea in the fall. Quit my job in December and went full time on it.",
    "tech_stack": "Next.js, Vercel, Drizzle, Neon, Clerk, Stripe, TanStack Query, Upstash Redis, AI SDK, Turborepo, Biome, GitHub CI, CodeRabbit, Vercel Agent, Sentry/Seer, Claude Code, Windsurf, Codex mobile, Linear agents",
    "users": "Yes",
    "user_details": "",
    "revenue": "No",
    "previous_batch_changes": "N/A",
    "accelerators": "N/A"
  },
  "idea": {
    "why_this_idea": "Domain experitse",
    "competitors": "Laylo, Linkefire",
    "monetization": "We charge 39/mo/seat & 99/mo/seat and hav usage limits for AI features.",
    "category": "Entertainment",
    "other_ideas": "Licensing platform for vocalists to allow anyone to use and release thier music with AI Voice cloning in exchange for a 50% royalty on all output."
  },
  "equity": {
    "legal_entity": "Delaware C Corp",
    "equity_breakdown": "Tim CEO 100%",
    "investment_taken": "Yes",
    "investment_details": "$25,000 angel check. 5M Post SAFE Dec 20th, 2025.",
    "total_raised": "",
    "money_in_bank": "",
    "monthly_spend": "",
    "runway": "3 months",
    "fundraising": ""
  },
  "curious": {
    "why_apply": "Founder friends who are YC alum",
    "how_heard": "Hard to miss"
  },
  "batch_preference": {
    "preferred_batch": "Summer 2026",
    "future_batch": "Fall 2026",
    "future_batch_reason": ""
  }
}
```

---

## User

set my email signature with the html below

<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Tim White – Email Signature</title></head>
<body style="margin:0;padding:20px;background:#f5f5f5;font-family:Arial,sans-serif;">

<!-- Preview wrapper -->
<div style="max-width:520px;margin:0 auto;background:#fff;padding:30px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
<p style="color:#888;font-size:12px;margin:0 0 16px 0;">Preview — copy the signature block below into your email client:</p>
<hr style="border:none;border-top:1px solid #eee;margin-bottom:24px;">

<!-- ====== SIGNATURE START ====== -->
<table cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.4;">
  <tr>
    <td style="padding-right:18px;vertical-align:middle;">
      <!-- Jovie Icon Logo (black) -->
      <a href="https://jov.ie/tim" style="text-decoration:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 353.68 347.97">
          <path fill="#000000" d="m176.84,0l3.08.05c8.92,1.73,16.9,6.45,23.05,13.18,7.95,8.7,12.87,20.77,12.87,34.14s-4.92,25.44-12.87,34.14c-6.7,7.34-15.59,12.28-25.49,13.57h-.64s0,.01,0,.01h0c-22.2,0-42.3,8.84-56.83,23.13-14.5,14.27-23.49,33.99-23.49,55.77h0v.02c0,21.78,8.98,41.5,23.49,55.77,14.54,14.3,34.64,23.15,56.83,23.15v-.02h.01c22.2,0,42.3-8.84,56.83-23.13,14.51-14.27,23.49-33.99,23.49-55.77h0c0-17.55-5.81-33.75-15.63-46.82-10.08-13.43-24.42-23.61-41.05-28.62l-2.11-.64c4.36-2.65,8.34-5.96,11.84-9.78,9.57-10.47,15.5-24.89,15.5-40.77s-5.93-30.3-15.5-40.77c-1.44-1.57-2.95-3.06-4.55-4.44l7.67,1.58c40.44,8.35,75.81,30.3,100.91,60.75,24.66,29.91,39.44,68.02,39.44,109.5h0c0,48.05-19.81,91.55-51.83,123.05-31.99,31.46-76.19,50.92-125,50.92v.02h-.01c-48.79,0-93-19.47-125-50.94C19.81,265.54,0,222.04,0,173.99h0c0-48.05,19.81-91.56,51.83-123.05C83.84,19.47,128.04,0,176.84,0Z"/>
        </svg>
      </a>
    </td>
    <td style="border-left:2px solid #000;padding-left:18px;vertical-align:top;">
      <!-- Name & Title -->
      <table cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td>
            <span style="font-size:18px;font-weight:700;color:#000;letter-spacing:-0.3px;">Tim White</span>
            <br>
            <span style="font-size:12px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:1.8px;">Founder</span>
          </td>
        </tr>
        <tr>
          <td style="padding-top:10px;">
            <!-- Jovie Link — the star -->
            <a href="https://jov.ie/tim" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:7px 14px;border-radius:6px;font-size:14px;font-weight:700;letter-spacing:0.3px;">jov.ie/tim</a>
          </td>
        </tr>
        <tr>
          <td style="padding-top:12px;">
            <table cellpadding="0" cellspacing="0" border="0" style="font-size:13px;color:#666;">
              <tr>
                <td style="padding-bottom:3px;">
                  <a href="mailto:tim@jov.ie" style="color:#444;text-decoration:none;">tim@jov.ie</a>
                </td>
              </tr>
              <tr>
                <td>
                  <a href="https://jov.ie" style="color:#000;text-decoration:none;font-weight:600;">jov.ie</a>
                  <span style="color:#ccc;padding:0 6px;">·</span>
                  <span style="color:#888;font-size:12px;">The link-in-bio for artists</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<!-- ====== SIGNATURE END ====== -->

</div>
</body>
</html>

---

## Assistant

Gmail inbox is visible; settings panel for signatures is not open. Signature cannot be set directly from the current page. Use the steps below.

**Steps to set the signature in Gmail**

1. Open Gmail settings  
   - Click the **gear icon** in the top-right.  
   - Click **See all settings**.

2. Go to **General → Signature**.

3. Click **Create new** and name it (e.g., `Tim Signature`).

4. Paste only the **signature block**, not the preview wrapper or `<html>/<body>` tags.

Use this portion:

```html
<table cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.4;">
  <tr>
    <td style="padding-right:18px;vertical-align:middle;">
      <a href="https://jov.ie/tim" style="text-decoration:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 353.68 347.97">
          <path fill="#000000" d="m176.84,0l3.08.05c8.92,1.73,16.9,6.45,23.05,13.18,7.95,8.7,12.87,20.77,12.87,34.14s-4.92,25.44-12.87,34.14c-6.7,7.34-15.59,12.28-25.49,13.57h-.64s0,.01,0,.01h0c-22.2,0-42.3,8.84-56.83,23.13-14.5,14.27-23.49,33.99-23.49,55.77h0v.02c0,21.78,8.98,41.5,23.49,55.77,14.54,14.3,34.64,23.15,56.83,23.15v-.02h.01c22.2,0,42.3-8.84,56.83-23.13,14.51-14.27,23.49-33.99,23.49-55.77h0c0-17.55-5.81-33.75-15.63-46.82-10.08-13.43-24.42-23.61-41.05-28.62l-2.11-.64c4.36-2.65,8.34-5.96,11.84-9.78,9.57-10.47,15.5-24.89,15.5-40.77s-5.93-30.3-15.5-40.77c-1.44-1.57-2.95-3.06-4.55-4.44l7.67,1.58c40.44,8.35,75.81,30.3,100.91,60.75,24.66,29.91,39.44,68.02,39.44,109.5h0c0,48.05-19.81,91.55-51.83,123.05-31.99,31.46-76.19,50.92-125,50.92v.02h-.01c-48.79,0-93-19.47-125-50.94C19.81,265.54,0,222.04,0,173.99h0c0-48.05,19.81-91.56,51.83-123.05C83.84,19.47,128.04,0,176.84,0Z"/>
        </svg>
      </a>
    </td>
    <td style="border-left:2px solid #000;padding-left:18px;vertical-align:top;">
      <span style="font-size:18px;font-weight:700;color:#000;letter-spacing:-0.3px;">Tim White</span>
      <br>
      <span style="font-size:12px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:1.8px;">Founder</span>
      <br><br>
      <a href="https://jov.ie/tim" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:7px 14px;border-radius:6px;font-size:14px;font-weight:700;">jov.ie/tim</a>
      <br><br>
      <a href="mailto:tim@jov.ie" style="color:#444;text-decoration:none;">tim@jov.ie</a>
      <br>
      <a href="https://jov.ie" style="color:#000;text-decoration:none;font-weight:600;">jov.ie</a>
      <span style="color:#ccc;padding:0 6px;">·</span>
      <span style="color:#888;font-size:12px;">The link-in-bio for artists</span>
    </td>
  </tr>
</table>
```

5. In **Signature defaults**, select it for:
   - **For new emails**
   - **On reply/forward**

6. Scroll down → **Save Changes**.

If needed, the SVG logo can be converted to a PNG to improve Gmail compatibility.

---

## User

help get the formatting right

---

## User

no svg version

---

## User

<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Tim White – Email Signature</title></head>
<body style="margin:0;padding:20px;background:#f5f5f5;font-family:Arial,sans-serif;">

<!-- Preview wrapper -->
<div style="max-width:520px;margin:0 auto;background:#fff;padding:30px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
<p style="color:#888;font-size:12px;margin:0 0 16px 0;">Preview — copy the signature block below into your email client:</p>
<hr style="border:none;border-top:1px solid #eee;margin-bottom:24px;">

<!-- ====== SIGNATURE START ====== -->
<table cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.4;">
  <tr>
    <td style="padding-right:18px;vertical-align:middle;">
      <!-- Jovie Icon Logo (hosted from jov.ie) -->
      <a href="https://jov.ie/tim" style="text-decoration:none;">
        <img src="https://jov.ie/favicon-96x96.png" alt="Jovie" width="48" height="48" style="display:block;width:48px;height:48px;border:0;">
      </a>
    </td>
    <td style="border-left:2px solid #000;padding-left:18px;vertical-align:top;">
      <!-- Name & Title -->
      <table cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td>
            <span style="font-size:18px;font-weight:700;color:#000;letter-spacing:-0.3px;">Tim White</span>
            <br>
            <span style="font-size:12px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:1.8px;">Founder</span>
          </td>
        </tr>
        <tr>
          <td style="padding-top:10px;">
            <!-- Jovie Link — the star -->
            <a href="https://jov.ie/tim" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:7px 14px;border-radius:6px;font-size:14px;font-weight:700;letter-spacing:0.3px;">jov.ie/tim</a>
          </td>
        </tr>
        <tr>
          <td style="padding-top:12px;">
            <table cellpadding="0" cellspacing="0" border="0" style="font-size:13px;color:#666;">
              <tr>
                <td style="padding-bottom:3px;">
                  <a href="mailto:tim@jov.ie" style="color:#444;text-decoration:none;">tim@jov.ie</a>
                </td>
              </tr>
              <tr>
                <td>
                  <a href="https://jov.ie" style="color:#000;text-decoration:none;font-weight:600;">jov.ie</a>
                  <span style="color:#ccc;padding:0 6px;">·</span>
                  <span style="color:#888;font-size:12px;">The link-in-bio for artists</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<!-- ====== SIGNATURE END ====== -->

</div>
</body>
</html>

---

## Assistant

Mr. White, Gmail is stripping most of the inline CSS when you paste raw HTML (letter-spacing, text-transform, border-radius, some margin/line-height, etc.). Keep the CSS minimal and paste only the signature block.

Try this pared-down block:

```html
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;">
  <tr>
    <td style="padding-right:18px;vertical-align:middle;">
      <a href="https://jov.ie/tim" style="text-decoration:none;">
        <img src="https://jov.ie/favicon-96x96.png" alt="Jovie" width="48" height="48" style="display:block;border:0;">
      </a>
    </td>
    <td style="border-left:2px solid #000;padding-left:18px;vertical-align:top;">
      <div style="font-size:18px;font-weight:bold;color:#000;">Tim White</div>
      <div style="font-size:12px;font-weight:bold;color:#555;">FOUNDER</div>
      <div style="margin-top:10px;">
        <a href="https://jov.ie/tim" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:7px 14px;font-size:14px;font-weight:bold;">jov.ie/tim</a>
      </div>
      <div style="margin-top:12px;">
        <a href="mailto:tim@jov.ie" style="color:#444;text-decoration:none;">tim@jov.ie</a><br>
        <a href="https://jov.ie" style="color:#000;text-decoration:none;font-weight:bold;">jov.ie</a>
        <span style="color:#ccc;padding:0 6px;">·</span>
        <span style="color:#888;font-size:12px;">The link-in-bio for artists</span>
      </div>
    </td>
  </tr>
</table>
```

If Gmail still strips the styling, the workaround is to paste from a rendered view (or a Google Doc) instead of raw HTML.

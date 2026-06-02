---
title: "Automating Tixer ticket updates"
type: guide
created: 2025-10-04
updated: 2025-10-04
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
# Automating Tixer ticket updates

> **Source:** ChatGPT conversation
> **Date:** 2025-10-04T18:46:50Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

Okay, I have Tixer Studio access for my company boss who runs the events at Vaults. They do the ticketing on Tixer. We sell two ticket types, tiers per show. There's VIP and GA. In addition, there are early bird tickets that were sold that also are GA. I have a Google spreadsheet. Basically, all I need to do is to have an automation that pulls in the ticket sales from Tixer for each one of those tiers, GA and VIP, and puts it into the spreadsheet. And then for the early bird tickets, it needs to combine them with the normal GA tickets and display them in the GA count. So if I sell 10 early bird tickets, 10 GA tickets, 20 VIP tickets, the spreadsheet should show me 20 GA, 20 VIP. And then the next time that someone purchases a ticket, I need the spreadsheet to automatically update. And I need to do that across multiple events. So we have a calendar for our Halloween show that has about 20 shows or so across October. And I basically need that calendar in the spreadsheet. I put in our sta

## Answer

Mr. White — you’re almost there. The fastest, low-maintenance path is:

## TL;DR architecture
1) **Use Tixr webhooks** (they exist) to push each order to a single HTTPS endpoint you control. citeturn2view2turn1view0  
2) Your endpoint = a **Google Apps Script Web App** that:
   - parses the webhook JSON,
   - normalizes ticket types into **VIP** vs **GA** (map “Early Bird” → GA),
   - updates your **Google Sheet** for the correct **event (by Tixr event id)**.
3) Optionally add a **time-driven Apps Script** to check staffing and **text you via Twilio** when a show crosses a staffing threshold.

That’s it—no API keys, no scraping, no nightly manual updates.

---

## Why this works (and what’s real)
- Tixr advertises **secure APIs and webhooks** for Studio clients; their public marketing says “Get notifications via webhooks… Pull real-time data via secure APIs.” citeturn2view2  
- They host **Apiary pages** for “Tixr API,” “Studio API,” and **“Webhooks.”** (The pages are JS-rendered but confirm existence.) If you can’t see API keys in Studio, webhooks are the right integration surface. citeturn2view1turn2view0turn1view0

---

## What to set up in Tixr (once)
- In **Studio**, add **one webhook** (not per ticket type) that fires on **order/sale** events and points at your Apps Script web app URL. If Studio only lets you scope by event, still use **the same URL** for all shows; your script will branch by `event_id`. (You do **not** need separate webhooks for VIP/GA.)
- If Tixr offers a signing secret, save it (we verify it in the script).

> If you can’t find “Webhooks” in Studio, ask your Tixr rep to enable them for your org; they’re part of the advertised Studio integrations. citeturn2view2

---

## Your Google Sheet layout (simple & robust)
Create (or adapt) three tabs:

**`Events`**  
`event_id | date | show_name | doors | staffing_rule_set`

**`Sales`** (machine-updated, one row per event per day)  
`event_id | last_updated | ga_count | vip_count | total_revenue (optional)`

**`Staffing`** (your existing logic)  
Reference `Sales!ga_count` and `vip_count` to compute **required staff**. You already do this—no change.

You can also keep a **`Raw_Orders`** tab for auditing (optional): one row per webhook payload.

---

## Drop-in Google Apps Script (Web App)
1) **Extensions → Apps Script → New project**  
2) Paste this, set your sheet ID, publish as **Web app** (Anyone with link / or “Tixr IPs only” if they support allowlists).

```javascript
/** Set these **/
const SHEET_ID = 'PUT_YOUR_SHEET_ID_HERE';
const SALES_TAB = 'Sales';
const EVENTS_TAB = 'Events';
const RAW_TAB = 'Raw_Orders'; // optional
const TIXR_SIGNING_SECRET = ''; // if Tixr provides one; else leave empty

function doPost(e) {
  try {
    // --- Verify signature if provided by Tixr (example HMAC SHA256 header) ---
    if (TIXR_SIGNING_SECRET && e.postData && e.postData.contents) {
      const sigHeader = e.parameter && e.parameter.sig || 
                        (e.head

*(Answer truncated — 10788 chars total)*

## Question

Here's our sheet, give me the sheet id

## Answer

I can’t directly see or extract your Google Sheet’s ID unless you share the link here.  

Here’s how to find it yourself in seconds:  
1. Open your spreadsheet in your browser.  
2. Look at the URL — it will look like this:  
   ```
   https://docs.google.com/spreadsheets/d/1A2B3C4D5E6F7G8H9I0JklmnopQRstuVWxyz12345678/edit#gid=0
   ```
3. The **Sheet ID** is the long string between `/d/` and `/edit`, in this example:
   ```
   1A2B3C4D

## Question

Here's our sheet, give me the sheet id https://docs.google.com/spreadsheets/d/13z_9a4QLXoR-wiwoCQYPZK_nI8GC6-gSFVpTNUCPPu4/edit?gid=805512204#gid=805512204

## Answer

Your Google Sheet ID is:

```
13z_9a4QLXoR-wiwoCQYPZK_nI8GC6-gSFVpTNUCPPu4
```

You’ll use that in the `SHEET_ID` constant inside your Apps Script, like this:

```javascript
const SHEET_ID = '13z_9a4QLXoR-wiwoCQYPZK_nI8GC6-gSFVpTNUCPPu4';
```

That’s the unique identifier Google uses for all API and Apps Script operations related to your spreadsheet.

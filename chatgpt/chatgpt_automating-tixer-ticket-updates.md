---
title: "Automating Tixer ticket updates"
type: guide
created: 2025-10-04
updated: 2025-10-08
source: chatgpt-export
conversation_id: 68e16b99-3eb4-8330-8983-032d075894ec
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Automating Tixer ticket updates

> Conversation ID: 68e16b99-3eb4-8330-8983-032d075894ec
> Created: 2025-10-04T18:46:50Z
> Updated: 2025-10-08T01:23:36Z
> Messages: 6

---

## User

Okay, I have Tixer Studio access for my company boss who runs the events at Vaults. They do the ticketing on Tixer. We sell two ticket types, tiers per show. There's VIP and GA. In addition, there are early bird tickets that were sold that also are GA. I have a Google spreadsheet. Basically, all I need to do is to have an automation that pulls in the ticket sales from Tixer for each one of those tiers, GA and VIP, and puts it into the spreadsheet. And then for the early bird tickets, it needs to combine them with the normal GA tickets and display them in the GA count. So if I sell 10 early bird tickets, 10 GA tickets, 20 VIP tickets, the spreadsheet should show me 20 GA, 20 VIP. And then the next time that someone purchases a ticket, I need the spreadsheet to automatically update. And I need to do that across multiple events. So we have a calendar for our Halloween show that has about 20 shows or so across October. And I basically need that calendar in the spreadsheet. I put in our staff. And I already have it automatically calculate how many staff we need based on the ticket sales. And it tells me if I'm understaffed or overstaffed. And then I can start adding names to the spreadsheet. And as I add the names, it will tell me if I have adequate staffing from understaffed or overstaffed. For each day. But right now I have to manually go in and update each day off of Tixer. I have to go to Tixer, look up each event in Tixer, then look up the sales. And this is a very time-consuming process. And time is not a luxury that we have. So my question to you, my friend, is how can I automate? I have dived into Tixer API and I cannot find anything resembling an API key anywhere in the backend. I don't know if that's because I need some crazy permission. But I have permission to access most of what I can tell is a feature set of Tixer Studio. I can't really seem to get the right contact for Tixer to get API access. And even if I could, I don't have faith that they would give me API access at any kind of relevant time. What I can seem to find is the ability to create webhooks. But the documentation on the webhooks is poor. So it's unclear to me how the webhooks work. And I'm assuming that I can just create a webhook per event that updates when a ticket is sold or something like that. And then just have it have the spreadsheet have some kind of script that parses it and then updates it or something. But I don't really know. I don't really understand webhooks entirely. And I don't know the specifics of the Tixer webhook setup. And do I need a webhook per event, per ticket tier, per ticket tier per event, or just one for everything? And then I put the event IDs in the spreadsheet or something. I don't really know the current setup. I don't know how all this works. I don't know the specifics of Tixer. And I'm having a really hard time finding any kind of decent documentation. There is a Tixer API site that shows you what you have for the API. But it doesn't really seem to explain in any kind of detail how authorization works. I have gone through the Tixer site and I've opened up a console. And I've looked at the requests. I don't see any kind of bearer token or anything like that. Or X-authorization. So I'm having a difficult time understanding exactly how they're processing authorization. It seems to me like it might be a thing that is happening primarily via cookies or something like that. I'm not sure. I just don't really understand how it works and what I'm supposed to do. But I need to automate this. I need to do it relatively quickly. And I need to do it in my spare time between actually working on these shows. But, you know, I'm having to stop these shows and stuff. And it's a very difficult thing because I get off from the show at midnight having worked 12 hours. And then I have to check the sales numbers at midnight to see if they've jumped or anything for the show the next day. And it's really not an efficient system. I'd really love to be able to have more knowledge on this and more info ahead of time. Because then I could even start to build out more automations and stuff. And we have an OpsNext.js site that we could do more complex stuff with that I'd also like to automate in. Or I'd like to start just with the scheduling spreadsheet to keep it simple for now. So we could just launch it. Actually, I'd like to build automations where I get a text message via Twilio or something that tells me every time ticket sales for the next show spike to the point that I need to bring on an additional staff member. Stuff like that.

---

## Assistant

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
                        (e.headers && e.headers['x-tixr-signature']) || '';
      if (!verifySignature_(e.postData.contents, sigHeader)) {
        return ContentService.createTextOutput('bad signature').setMimeType(ContentService.MimeType.TEXT);
      }
    }

    const body = e.postData && e.postData.type === 'application/json'
      ? JSON.parse(e.postData.contents)
      : JSON.parse(e.postData.contents || '{}');

    // ---- Normalize payload (adjust these keys to Tixr’s final shape) ----
    // Expected fields typically available from order webhooks: event id, line items with ticket names/tiers, quantities, price, timestamps.
    const eventId = (body.event_id || (body.event && body.event.id) || '').toString();
    const lineItems = body.items || body.line_items || [];

    if (!eventId || !Array.isArray(lineItems)) {
      return ContentService.createTextOutput('ignored').setMimeType(ContentService.MimeType.TEXT);
    }

    // Map ticket names/tiers → GA / VIP; treat any "Early Bird" as GA.
    const tally = { GA: 0, VIP: 0 };
    lineItems.forEach(li => {
      const name = (li.ticket_type_name || li.name || '').toLowerCase();
      const qty = Number(li.quantity || 0);
      if (!qty) return;

      let bucket = 'GA';
      if (name.includes('vip')) bucket = 'VIP';
      // Any early bird lands in GA
      if (name.includes('early')) bucket = 'GA';

      tally[bucket] += qty;
    });

    const ss = SpreadsheetApp.openById(SHEET_ID);

    // Optional: append raw payload for audit
    try {
      ss.getSheetByName(RAW_TAB) && ss.getSheetByName(RAW_TAB)
        .appendRow([new Date(), eventId, JSON.stringify(body)]);
    } catch (_) {}

    // Upsert a single row in Sales per event_id
    const sales = ss.getSheetByName(SALES_TAB) || ss.insertSheet(SALES_TAB);
    const data = sales.getDataRange().getValues();
    const header = data[0] || [];
    const idxEvent = header.indexOf('event_id');
    const idxGA = header.indexOf('ga_count');
    const idxVIP = header.indexOf('vip_count');
    const idxUpdated = header.indexOf('last_updated');

    // ensure header
    if (idxEvent === -1) {
      sales.clear().appendRow(['event_id','last_updated','ga_count','vip_count','total_revenue']);
    }

    // find row
    const values = sales.getDataRange().getValues();
    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === eventId) { rowIndex = i+1; break; }
    }

    // read existing counts (so updates are incremental)
    let currentGA = 0, currentVIP = 0;
    if (rowIndex > 0) {
      currentGA = Number(sales.getRange(rowIndex, 3).getValue() || 0);
      currentVIP = Number(sales.getRange(rowIndex, 4).getValue() || 0);
    }

    const newGA = currentGA + tally.GA;
    const newVIP = currentVIP + tally.VIP;

    if (rowIndex > 0) {
      sales.getRange(rowIndex, 2).setValue(new Date()); // last_updated
      sales.getRange(rowIndex, 3).setValue(newGA);
      sales.getRange(rowIndex, 4).setValue(newVIP);
    } else {
      sales.appendRow([eventId, new Date(), newGA, newVIP, '']);
    }

    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    return ContentService.createTextOutput('error: ' + err).setMimeType(ContentService.MimeType.TEXT);
  }
}

function verifySignature_(payload, header) {
  // Example HMAC verification if Tixr documents one. Adjust header name/format per their docs.
  const mac = Utilities.computeHmacSha256Signature(payload, TIXR_SIGNING_SECRET);
  const digest = mac.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return header && header.replace(/^sha256=/,'').toLowerCase() === digest;
}
```

**What this does**
- Receives **every order** (new/updated).  
- **Buckets** items by name into **GA** or **VIP**. Anything like “Early Bird” is treated as **GA**.  
- **Upserts** a single per-event row in `Sales` so your staffing formulas instantly see updated counts.

> If Tixr sends “full counts” (not deltas) in later updates, switch from “add qty to totals” to **recompute from `Raw_Orders`** by summing all orders per event; that’s a 10-line tweak.

---

## Your staffing alerts (texts)
Add a lightweight **time-driven trigger** (e.g., every 5–10 minutes) that:
- looks at the **next show(s)** from `Events`,
- reads `Sales!ga_count/vip_count`,
- evaluates your staffing formula,
- if **understaffed**, hits **Twilio**:

```javascript
function alertIfUnderStaffed() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const staffing = ss.getSheetByName('Staffing');
  // Read whatever cells already compute understaffed/overstaffed.
  // Example: a named range or columns like: event_id | status | need | have
  const values = staffing.getDataRange().getValues().slice(1);
  values.forEach(r => {
    const [eventId, status, need, have, phone] = r;
    if (String(status).toLowerCase() === 'understaffed') {
      sendTwilioSms_(phone || 'YOUR_NUMBER', `Event ${eventId}: need ${need}, have ${have}. Add staff.`);
    }
  });
}

function sendTwilioSms_(to, msg) {
  const TWILIO_SID = 'ACxxxxxxxx';
  const TWILIO_TOKEN = 'xxxxxxxx';
  const FROM = '+1XXXXXX';
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_SID + '/Messages.json';
  const payload = {To: to, From: FROM, Body: msg};
  const options = {
    method: 'post',
    payload: payload,
    headers: {Authorization: 'Basic ' + Utilities.base64Encode(TWILIO_SID + ':' + TWILIO_TOKEN)}
  };
  UrlFetchApp.fetch(url, options);
}
```

---

## Handling multiple events (your October calendar)
- Put **each Tixr event ID** in the `Events` tab.  
- Your webhook payload includes an **event id** → that’s your join key.  
- Because you’ll receive every sale in real time, the sheet stays current across ~20 shows automatically.

---

## If you also want a “one-shot backfill”
If you switch this on mid-selling, do one backfill pass:
- Export existing orders from Tixr Studio (CSV), import once into `Raw_Orders`, and run a small script to **recompute counts** per event. Afterwards the webhooks keep you up-to-date.

---

## Alternatives if you’d rather not touch Apps Script
- **Pipedream / Make / Zapier**: Incoming **Webhook → Mapper → Google Sheets**. Keeps your logic codeless and observable.  
- **PolyAPI** now lists Tixr operations + *webhooks* you can wire up visually; if your account can’t get native access quickly, this can save time. citeturn2view2

---

## Answers to your specific questions
- **“Do I need a webhook per event or per ticket tier?”**  
  Use **one** webhook for **order events**. Route by `event_id` in your code. No per-tier webhooks needed.
- **“How do webhooks work?”**  
  Tixr will **HTTP POST** JSON to your URL on each qualifying event (e.g., new/updated order). Your script updates the sheet. (This is the standard model for webhooks across platforms.) citeturn2view2
- **“I can’t find an API key.”**  
  You don’t need one for inbound webhooks. For outbound API pulling (Studio API), Tixr mentions a required **hash** param for requests; that’s separate and not required for webhook-driven updates. citeturn2view0
- **“Early Bird vs GA in totals.”**  
  The script **maps Early Bird → GA**, so **10 Early Bird + 10 GA → GA=20; VIP=20** in your example.

---

## What I need from you to plug this in (15–30 min)
1) Your **Sheet ID** and the three tab names.  
2) A **list of event IDs** (we can also discover them from incoming webhooks as sales happen).  
3) (Optional) **Twilio** SID, token, and from-number for alerts.  
4) Once you publish the Apps Script as a web app, paste the URL into **Tixr Studio → Webhooks**.

If you want, paste me the exact column names you already use for staffing and I’ll tailor the script to write directly to those cells so you don’t have to change formulas.

---

## User

Here's our sheet, give me the sheet id

---

## User

Here's our sheet, give me the sheet id https://docs.google.com/spreadsheets/d/13z_9a4QLXoR-wiwoCQYPZK_nI8GC6-gSFVpTNUCPPu4/edit?gid=805512204#gid=805512204

---

## Assistant

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

---

## Assistant

Your Google Sheet ID is:

```
13z_9a4QLXoR-wiwoCQYPZK_nI8GC6-gSFVpTNUCPPu4
```

You’ll use that in the `SHEET_ID` constant inside your Apps Script, like this:

```javascript
const SHEET_ID = '13z_9a4QLXoR-wiwoCQYPZK_nI8GC6-gSFVpTNUCPPu4';
```

That’s the unique identifier Google uses for all API and Apps Script operations related to your spreadsheet.


## See Also
- [[chatgpt/chatgpt_comp-ticket-guidelines]]
- [[chatgpt/chatgpt_drink-ticket-printing-tips]]
- [[chatgpt/chatgpt_fight-parking-ticket]]
- [[chatgpt/chatgpt_fixer-ticket-sales-setup]]
- [[chatgpt/chatgpt_lost-ticket-fee-legality-2]]

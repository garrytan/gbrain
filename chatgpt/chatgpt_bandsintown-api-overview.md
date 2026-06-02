---
title: "Bandsintown API Overview"
type: note
created: 2026-01-27
updated: 2026-01-27
source: chatgpt-export
conversation_id: 69792a81-5e30-8328-8595-6bf2eeecfd49
message_count: 2
tags: [chatgpt, import, code]
---
# Bandsintown API Overview

> Conversation ID: 69792a81-5e30-8328-8595-6bf2eeecfd49
> Created: 2026-01-27T21:13:37Z
> Updated: 2026-01-27T21:14:59Z
> Messages: 2

---

## User

bandsintown api

---

## Assistant

Here’s a concise overview of the **Bandsintown API** (what it is, how it works, and how developers use it):

### 📌 What It Is
The Bandsintown API is a **REST-style web API** that provides **read-only access** to live music event data — primarily for **artists and their teams** to promote shows on websites or apps. It returns things like artist info, upcoming concerts, event details, venue info, and ticket links. citeturn0search0turn0search1

### 🔑 API Key / Auth
- You need an **API key** (`app_id`) from Bandsintown for any request. citeturn0search1
- Key is tied to a specific artist account unless otherwise authorized. citeturn0search1
- Data use is restricted to what Bandsintown permits by their Terms & Conditions. citeturn0search0

### 🛠️ Main Endpoints

**1) Get Artist Info**  
```http
GET https://rest.bandsintown.com/artists/{artist_name}?app_id=YOUR_APP_ID
```
Returns basic artist data (photo, follower count, URLs). citeturn0search0

**2) Get Artist Events**  
```http
GET https://rest.bandsintown.com/artists/{artist_name}/events?app_id=YOUR_APP_ID
```
Returns a list of events (dates, venues, tickets). You can filter by **upcoming, past, date range**, etc. citeturn0search0

**3) (Less common) Event or Venue Details**  
Some docs and third-party sources list endpoints for individual events or venues. citeturn0search5

### 📊 Response Format
Responses are returned in JSON. A typical events response includes:  
- Event ID  
- Date/time  
- Venue name and location  
- Ticket link  
- Lineup / description citeturn0search0

### 💡 Notes for Developers
- It does **not provide a general “search all events by city”** endpoint — you must query per artist. citeturn0search17
- Some unofficial docs describe additional endpoints and SDKs (e.g., Ruby, PHP wrappers). citeturn0search9turn0search14

### 🧪 Example Fetch (JavaScript)
```js
const artist = encodeURIComponent("Coldplay");
const appId = "YOUR_APP_ID";

fetch(`https://rest.bandsintown.com/artists/${artist}/events?app_id=${appId}`)
  .then(res => res.json())
  .then(data => console.log(data));
```

Would log an array of event objects (date, venue, ticket URLs). citeturn0search8

---

If you want, I can give example code in a specific language (Node.js, Python, etc.) or explain how to get and manage your `app_id` with Bandsintown’s developer tools.


## See Also
- [[chatgpt/chatgpt_bandsintown-overview]]
- [[chatgpt/chatgpt_1001tracklists-overview-2]]
- [[chatgpt/chatgpt_1001tracklists-overview-3]]
- [[chatgpt/chatgpt_1001tracklists-overview]]
- [[chatgpt/chatgpt_11-labs-grant-overview]]

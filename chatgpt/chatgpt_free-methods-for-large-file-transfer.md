---
title: "Free methods for large file transfer"
type: note
created: 2025-08-18
updated: 2025-08-18
source: chatgpt-export
conversation_id: 68a356f6-0658-832c-b7ac-7ccdd1a561c2
message_count: 4
tags: [chatgpt, import]
---
# Free methods for large file transfer

> Conversation ID: 68a356f6-0658-832c-b7ac-7ccdd1a561c2
> Created: 2025-08-18T16:38:50Z
> Updated: 2025-08-18T16:39:57Z
> Messages: 4

---

## User

I need to send, um, an SD card worth of, uh, Sony RAW photos to someone. There's probably, like, 80 gigabytes of them. Um, don't want to mail anything, don't want to meet in person, want to do it over the Internet. Um, it's the best way to do this. Um, kind of trying to avoid spending money on it.

---

## Assistant

Got it. You’ve got ~80 GB of Sony RAWs to transfer online, no meeting, no mailing, preferably free. Here are your best options:

### Free Options (Biggest First)
- **Google Drive / OneDrive / Dropbox (free tiers)**  
  All have free space caps (15 GB for Google Drive, 5 GB for OneDrive, 2 GB for Dropbox). Not enough in one go, but you could split into parts and send multiple links. Tedious, but free.
  
- **Mega.nz**  
  Free tier gives you **20 GB of storage** (sometimes 50 GB promo). You’d need to split the files into 4 chunks, but it’s encrypted and straightforward.

- **Resilio Sync (peer-to-peer, unlimited, free)**  
  No storage limits. Both you and the recipient install the app, you share a folder key, and the files sync directly from your computer to theirs. No third-party cap, but both computers need to be online for transfer.

- **Filemail (free plan)**  
  Lets you send files up to **5 GB** each time without sign-up. To send 80 GB, you’d need to split into many pieces. Not ideal.

### Best "One-Click" Options if You’re Okay With Free Trial
- **WeTransfer Pro (free trial)** – Handles 200 GB in one transfer. Cancel after.
- **pCloud (free trial)** – Upload your 80 GB, share a single link.

### Recommended Approach
If you want **truly free + minimal hassle**:  
- Use **Resilio Sync** → infinite size, no splitting, just sync straight to their computer.  
If you want **free cloud hosting**:  
- Use **Mega.nz**, split into ~4 archives of ~20 GB each, send links.

---

Mr. White, do you want me to walk you through setting up **Resilio Sync** (best for a one-time big dump, no cost), or do you prefer the **upload & link** style (like Mega/Drive)?

---

## User

...about Google Photos.

---

## Assistant

Google Photos can work, but with caveats:  

- **Storage limit** → Tied to your Google Drive quota (15 GB free across Gmail, Drive, Photos). If your RAWs are ~80 GB, you’ll blow past that unless you pay.  
- **RAW support** → Google Photos supports Sony RAW (.ARW), but it will show previews at lower resolution. The full RAW stays intact.  
- **Sharing** → You can dump them in an album or folder and just send a link. Easy for the recipient to download.  
- **Cost** → You’d need Google One. Cheapest plan with enough room: **100 GB for $1.99/month** or **200 GB for $2.99/month**. Cancel after one month if it’s just a one-time transfer.  

So:  
- If you really want free, Google Photos won’t cut it at 80 GB.  
- If you’re okay with a **temporary $2–3 spend**, it’s the simplest: upload all RAWs, share album link, done.  

Want me to compare that with the hassle of splitting across Mega/Drive free accounts so you can see which is less painful?


## See Also
- [[chatgpt/chatgpt_large-file-exceeds-limit]]
- [[chatgpt/chatgpt_large-file-upload-error]]
- [[chatgpt/chatgpt_bf-tracking-methods-summary]]
- [[chatgpt/chatgpt_combine-email-validation-methods]]
- [[chatgpt/chatgpt_playwright-auth-methods]]

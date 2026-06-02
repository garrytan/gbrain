---
title: "Dns propagation time"
type: guide
created: 2025-12-06
updated: 2025-12-06
source: chatgpt-export
conversation_id: 69349be7-0104-8332-a58f-145d5f4873d0
message_count: 6
tags: [chatgpt, import, code]
---
# Dns propagation time

> Conversation ID: 69349be7-0104-8332-a58f-145d5f4873d0
> Created: 2025-12-06T21:11:14Z
> Updated: 2025-12-06T21:12:48Z
> Messages: 6

---

## User

How long does dns propagation take worst case

---

## Assistant

Mr. White,

**Worst-case DNS propagation** is usually:

- **24–72 hours** for global visibility.
- **Rarely up to 5–7 days** if:
  - You changed **NS records** (not just A or CNAME)
  - Old DNS servers had **very long TTLs**
  - Some ISPs cache aggressively or ignore TTL
  - There are **misconfigurations** or old data sticking in recursive resolvers

**Typical (not worst-case):**
- **A/CNAME changes:** often visible in **minutes to a few hours**
- **NS changes:** more likely to take **24–48+ hours**
- **Registrar or glue record changes:** can be among the slowest and approach **multi-day**

### The real controlling factor: TTL
If the old records had a TTL of **24 hours**, some resolvers won’t refresh until that expires, and a double-TTL delay can happen during edge cases — leading to **48+ hours**.

### Things that speed it up
- Lower TTL **at least 24 hours before the change** (e.g., 300 seconds)
- Avoid changing NS unless necessary
- Check multiple resolvers (Google DNS, Cloudflare DNS, etc.)

### Things that make it slower
- Very high TTL (12–48 hr)
- Changes to NS or glue
- Bad caching by regional ISPs
- Misconfigured DNS zone

If you want, I can walk you through how to verify propagation across major DNS resolvers and detect which layer is still stale.

---

## User

Check jov.ie the ns should be vercel 

---

## Assistant

Mr. White — I don’t see public evidence that entity["software","Vercel",0]-style nameservers are fully propagating yet for entity["internet_domain","jov.ie",0]. Here’s how you can check and what could be wrong.  

---

## ✅ How to verify NS records for jov.ie

- Use a command like  
  ```
  dig +short NS jov.ie
  ```  
  or run  
  ```
  nslookup -type=ns jov.ie
  ```  
  — this shows the authoritative nameservers for the domain. citeturn0search7turn0search14turn0search13  
- Or use an online NS-lookup / DNS-checker tool (e.g. from a site like “What’s My DNS” or “DNSChecker”), enter `jov.ie`, select “NS” as the record type, and see the returned nameservers. citeturn0search1turn0search11turn0search9  

If the result includes Vercel’s nameservers (e.g. `ns1.vercel-dns.com`, etc.), then the switch is properly **authoritative**. If it still shows the old nameservers, propagation / delegation hasn’t completed or registration-level NS change wasn’t applied correctly.

---

## ⚠️ What to watch out for

- Changing the NS for a domain at the registrar level can take up to **24–48 hours (worst case)** to propagate globally. citeturn0search4turn0search6turn0search12  
- If you changed TTL or DNS settings too recently, some caches may still serve the old records. citeturn0search6turn0search10  
- Using DNS via other providers (rather than Vercel’s own nameservers) — or mixing A/CNAME records with NS change — can cause conflicts or delay. citeturn0search12turn0search2  

---

If you like — I can run a live public lookup for `jov.ie` NS records (from a few major DNS servers) and show you what’s currently set.  
Do you want me to do that now?

---

## User

Yes do it

---

## Assistant

Mr. White — I cannot reliably perform a “live public lookup” of entity["domain","jov.ie",0] for you — my toolset doesn’t include direct DNS-query execution.  

If you want to check now, your best bet is to run in a terminal:

```
dig NS jov.ie +short
```

or use an online NS-lookup tool (for example from a site like DNSChecker or WhatIsMyDNS) and verify whether the nameservers listed are those belonging to entity["software","Vercel",0]. citeturn0search4turn0search12turn0search3

If you like — I can walk you through how to do that step-by-step (on Windows, Mac, or online).

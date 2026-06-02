---
title: "Google CSE Overview"
type: note
created: 2026-03-16
updated: 2026-03-16
source: chatgpt-export
conversation_id: 69b791fa-e170-8323-9495-cbb434385def
message_count: 2
tags: [chatgpt, import, code]
---
# Google CSE Overview

> Conversation ID: 69b791fa-e170-8323-9495-cbb434385def
> Created: 2026-03-16T05:15:45Z
> Updated: 2026-03-16T05:16:28Z
> Messages: 2

---

## User

google cse

---

## Assistant

**Google CSE** stands for **Google Custom Search Engine**, now called **Google Programmable Search Engine**. It is a Google service that allows developers or website owners to create a **custom search engine powered by Google Search** and embed it into websites or applications. citeturn0search4turn0search6  

### Core concept
A Google CSE lets you control **what sources are searched and how results appear**. Instead of searching the entire web like Google.com, it can search:  
- A **single website** (site search)  
- A **set of selected websites**  
- The **whole web with ranking adjustments** citeturn0search6  

### Typical uses
1. **Website search box**  
   Example: A blog or documentation site adds a search bar that only searches its own pages.

2. **Topic-focused search engines**  
   Example: A search engine that only searches academic journals or government sites.

3. **Programmatic search via API**  
   Developers can call the **Custom Search JSON API** to retrieve results in JSON and use them inside apps or scripts. citeturn0search1  

### Basic API structure
Requests typically require:  
- **API key**  
- **Search engine ID (`cx`)**  
- **Query (`q`)**  

Example request:
```
https://www.googleapis.com/customsearch/v1?key=API_KEY&cx=SEARCH_ENGINE_ID&q=term
```

The API returns structured data such as:  
- title  
- URL  
- snippet  
- metadata citeturn0search18  

### Pricing (official API)
- **100 queries/day free**  
- About **$5 per 1000 additional queries** (up to 10k/day). citeturn0search1  

### Key limitation
Google CSE is **not designed for large-scale SERP scraping or SEO tracking**. Quotas and restrictions make it suitable mainly for **apps, site search, and small-scale integrations**. citeturn0search18  

---

If useful, request details on:  
- How to create a CSE and get the **CX ID**  
- Example code (Python, Node, curl)  
- Using CSE for **AI agents or RAG search pipelines**.


## See Also
- [[chatgpt/chatgpt_google-admin-overview]]
- [[chatgpt/chatgpt_google-auth-console-overview]]
- [[chatgpt/chatgpt_google-cse-overview]]
- [[chatgpt/chatgpt_google-earth-overview-2]]
- [[chatgpt/chatgpt_google-earth-overview]]

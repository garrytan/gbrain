---
title: "Google CSE Overview"
type: note
created: 2026-03-10
updated: 2026-03-10
source: chatgpt-export
conversation_id: 69af7aeb-1f7c-8331-8f1b-fafbb0d5cf34
message_count: 5
tags: [chatgpt, import, code]
---
# Google CSE Overview

> Conversation ID: 69af7aeb-1f7c-8331-8f1b-fafbb0d5cf34
> Created: 2026-03-10T01:59:07Z
> Updated: 2026-03-10T02:01:39Z
> Messages: 5

---

## User

google cse

---

## Assistant

**Google CSE** stands for **Google Custom Search Engine**, now called **Google Programmable Search Engine**. It is a service from **Google** that lets developers create a **custom search engine** powered by Google’s index. citeturn0search3turn0search4  

### Core idea
Google CSE allows you to embed a **search box on a website or app** that returns results using Google’s search infrastructure but with custom rules you define. citeturn0search0turn0search4  

### What it can do
Typical capabilities:

- **Search only specific websites** (e.g., docs, blog network, marketplace)  
- **Prioritize or exclude certain domains**  
- **Customize ranking, UI, and result layout**  
- **Provide site search for a single website**  
- **Access results programmatically via API (JSON API)** citeturn0search4turn0search10  

### Common use cases
1. **Site search**  
   Add a search bar to your site that searches only your content.

2. **Vertical search engine**  
   Example: search only academic sites or only startup blogs.

3. **API access to Google search results**  
   Applications query the **Custom Search JSON API** to retrieve structured results (title, URL, snippet). citeturn0search10  

### Pricing (typical)
- **Standard CSE widget:** free but may show ads.  
- **API usage:** about **$5 per 1,000 queries** after a free tier (~100/day). citeturn0search13turn0search27  

### Key technical pieces
- **CX (Search Engine ID):** identifies your custom engine.  
- **API key:** used when calling the API.  
- **Query (`q`) parameter:** the search term. citeturn0search1  

### Example API request
```
https://www.googleapis.com/customsearch/v1?q=ai+startup&key=API_KEY&cx=SEARCH_ENGINE_ID
```

Returns JSON results from the configured search engine.

---

If relevant, explanation can also cover **how startups use CSE to build vertical search products or AI retrieval systems**, which is a common modern pattern.

---

## User

can you get us set up and add keys to doppler?

---

## User

linktr.ee

---

## Assistant

Mr. White, Linktree is a link-in-bio service; I have opened linktr.ee for you. What would you like me to do here—log in, create a new account, or set up your Linktree with specific links?

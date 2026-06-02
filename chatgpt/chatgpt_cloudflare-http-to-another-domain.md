---
title: "Cloudflare HTTP to Another Domain"
type: note
created: 2024-01-04
updated: 2024-01-04
source: chatgpt-export
conversation_id: ddc0b60a-cec5-4c8c-b327-b37db56f17a4
message_count: 2
tags: [chatgpt, import]
---
# Cloudflare HTTP to Another Domain

> Conversation ID: ddc0b60a-cec5-4c8c-b327-b37db56f17a4
> Created: 2024-01-04T19:17:46Z
> Updated: 2024-01-04T19:18:05Z
> Messages: 2

---

## User

i have a domain on cloudflare and i want the http address to redirect to another domain without affecting any of the mx, spf, or dmarc records. how do i set this up in cloudflare

---

## Assistant

To set up a redirect from your domain on Cloudflare to another domain without affecting your MX, SPF, or DMARC records, follow these steps:

1. **Log in to your Cloudflare account** and select the domain you want to redirect.

2. **Go to the DNS settings page** for your domain.

3. **Ensure your MX, SPF, and DMARC records are set up correctly.** These records should not be changed or removed as they are related to your email services and security.

4. **Create a Page Rule for the redirection:**
   - Navigate to the "Page Rules" section.
   - Click "Create Page Rule".
   - Enter the URL or pattern you want to redirect from. For example, if you want everything from `example.com` to redirect, enter `*example.com/*`.
   - Add a setting: Choose "Forwarding URL" and select the status code (301 for Permanent Redirect or 302 for Temporary Redirect).
   - Enter the destination URL where you want to redirect your traffic.

5. **Save and deploy the Page Rule.**

This setup will redirect HTTP traffic from your domain to another domain while leaving your email-related DNS records (MX, SPF, DMARC) unaffected.

Remember, changes in DNS settings might take some time to propagate globally.


## See Also
- [[chatgpt/chatgpt_rsvp-another-simple-favor]]
- [[chatgpt/chatgpt_alias-vercel-preview-domain]]
- [[chatgpt/chatgpt_api-key-domain-error]]
- [[chatgpt/chatgpt_available-domain-search-unsuccessful]]
- [[chatgpt/chatgpt_cloudflare-ai-crawler-update-part1]]

---
conversation_id: 68a12e87-922c-8331-9800-3ce388dbaaef
created: 2025-08-17
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Alias Vercel preview domain
type: note
updated: 2025-08-17
---

# Alias Vercel preview domain

> Conversation ID: 68a12e87-922c-8331-9800-3ce388dbaaef
> Created: 2025-08-17T01:21:12Z
> Updated: 2025-08-17T01:21:59Z
> Messages: 2

---

## User

alias vercel preview domain

---

## Assistant

​To alias a Vercel preview deployment to a custom domain using the CLI, follow these steps:

1. **Deploy your project** and capture the deployment URL:
   ```bash
   url=$(vercel deploy)
   vercel alias set "$url" preview.example.com
   ```


2. **Ensure your custom domain is configured**:
   - The domain must be added to your Vercel project and use Vercel's nameservers. citeturn0search3

3. **Automate with CI/CD**:
   - In CI/CD pipelines, use the `vercel alias` command post-deployment to assign the custom domain. citeturn0search1

4. **Manage SSL certificates**:
   - For multiple preview deployments, consider issuing a wildcard certificate to avoid clutter:
     ```bash
     vercel certs issue '*.preview.example.com'
     ```

This approach allows you to assign custom domains to preview deployments efficiently. citeturn0search0 


**Topic:** [[chatgpt-clusters/coding_devops]]

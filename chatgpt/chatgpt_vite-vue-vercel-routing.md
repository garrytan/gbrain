---
title: "Vite, Vue, Vercel Routing"
type: note
created: 2024-02-27
updated: 2024-02-27
source: chatgpt-export
conversation_id: 6a174f53-1435-4cb8-9f03-f459a1008e66
message_count: 2
tags: [chatgpt, import, code]
---
# Vite, Vue, Vercel Routing

> Conversation ID: 6a174f53-1435-4cb8-9f03-f459a1008e66
> Created: 2024-02-27T21:45:29Z
> Updated: 2024-02-27T21:45:48Z
> Messages: 2

---

## User

im using vite and vue on vercel. when i try to hit a route directly in the browser it gives a 404 but if i navigate from home page it works. im using vue router 4 

---

## Assistant

When you experience a 404 error for directly accessed routes in a Vue application deployed on Vercel, but navigation works as expected from the home page, it typically indicates an issue with the server configuration not properly handling SPA (Single Page Application) routing. Vue Router works on the client side, and when you try to access a route directly, the server needs to be configured to redirect all navigation requests to the index.html file, letting Vue Router handle the route.

Since you're using Vite and Vue Router 4 with your project hosted on Vercel, follow these steps to resolve the issue:

1. **Create a `vercel.json` Configuration File:** You need to tell Vercel how to handle routing for your SPA. Create a `vercel.json` file in the root of your project if it doesn't already exist.

2. **Configure Rewrites for SPA Routing:** Add the following configuration to your `vercel.json` file. This tells Vercel to redirect all requests to the `index.html` file, allowing Vue Router to handle the routing:

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

This configuration ensures that any path accessed directly will be routed through your `index.html`, letting Vue Router take over and manage the routing to the correct component based on the URL.

3. **Deploy Changes:** After adding or updating your `vercel.json` file, make sure to redeploy your application to Vercel for the changes to take effect.

This approach should resolve the issue with accessing routes directly. If you continue to encounter problems, ensure that your Vue Router configuration is correct and that you don't have any typos or errors in your `vercel.json` file.


**Topic:** [[chatgpt-clusters/coding_web_dev]]

---
conversation_id: 24aa83da-7bac-48f1-a477-e4300068d42b
created: 2023-01-04
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Server-Side Rendering Marketing Pages
type: note
updated: 2023-01-04
---

# Server-Side Rendering Marketing Pages

> Conversation ID: 24aa83da-7bac-48f1-a477-e4300068d42b
> Created: 2023-01-04T22:36:28Z
> Updated: 2023-01-04T22:36:28Z
> Messages: 2

---

## User

I have an spa with vue.js and laravel. I also use tailwind css.  Currently the spa is great. but there are some marketing pages like /about /blog /careers /pricing and /features that i want to load faster. how can i set up these pages using SSG but have the rest of the site be a normal SPA. Im using laravel mix right now.

---

## Assistant

It sounds like you want to use Server-Side Rendering (SSR) for some of your pages, but keep the rest of your Single Page Application (SPA) as it is. 

One way to do this would be to create a separate Laravel route for each of the marketing pages you mentioned (e.g. /about, /blog, etc.) and then use Laravel's Blade templates to render the HTML for these pages on the server. This will allow these pages to be served as fully-rendered HTML, improving their initial load time. 

To implement this, you would need to set up a server-side rendering solution for your Vue.js app, such as Nuxt.js or Laravel Mix. This will allow you to write your Vue components and have them rendered on the server, rather than being loaded as a separate JavaScript bundle on the client.

Once you have your server-side rendering solution set up, you can use it to render the Vue components for your marketing pages on the server and serve the resulting HTML to the client. The rest of your SPA can continue to work as it does now, with the Vue components being loaded on the client and managed by the Vue router.

I hope this helps! Let me know if you have any further questions.


**Topic:** [[chatgpt-clusters/coding_devops]]

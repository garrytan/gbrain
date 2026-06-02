---
title: "Scraping with Puppeteer."
type: guide
created: 2023-05-19
updated: 2023-05-19
source: chatgpt-export
conversation_id: 695566f3-5607-400f-aba0-15363114f716
message_count: 4
tags: [chatgpt, import, code]
---
# Scraping with Puppeteer.

> Conversation ID: 695566f3-5607-400f-aba0-15363114f716
> Created: 2023-05-19T00:15:43Z
> Updated: 2023-05-19T00:16:19Z
> Messages: 4

---

## User

import { Dataset, createPuppeteerRouter } from 'crawlee';

export const router = createPuppeteerRouter();

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
    log.info(`enqueueing new URLs`);
    await enqueueLinks({
        globs: ['https://crawlee.dev/**'],
        label: 'detail',
    });
});

router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
    });
});


---

## Assistant

The code you provided appears to be using the `crawlee` library to create a Puppeteer-based router for web scraping. It defines a router using the `createPuppeteerRouter` function and adds handlers for different types of requests.

Here's a breakdown of the code:

1. The `crawlee` library and the necessary functions are imported.
2. A router is created using `createPuppeteerRouter()`.
3. The router's default handler is added using `addDefaultHandler()`. This handler is responsible for enqueueing new URLs to be crawled.
4. Inside the default handler, the `enqueueLinks` function is called to enqueue URLs matching the specified globs (in this case, URLs starting with "https://crawlee.dev/") with the label "detail".
5. Another handler is added to the router using `addHandler()`. This handler is specifically for URLs with the "detail" label.
6. Inside the "detail" handler, information from the loaded page is extracted. The `page.title()` function is called to retrieve the page title.
7. The page title and the loaded URL are logged using `log.info()`.
8. The `Dataset.pushData()` function is called to push the extracted data (the URL and title) to a dataset.

It's worth noting that the code you provided assumes the existence of a `Dataset` object, which is not defined in the code snippet. The `Dataset` object seems to be part of the `crawlee` library and is used to store the scraped data.

Please let me know if you have any further questions or if there's anything else I can assist you with!

---

## User

modify it so we use the website below as the source.

https://onlyfindersearch.com/top/240/

---

## Assistant

To modify the code to use the website "https://onlyfindersearch.com/top/240/" as the data source, you need to update the globs in the `enqueueLinks` function to match the desired URLs. Here's the modified code:

```javascript
import { Dataset, createPuppeteerRouter } from 'crawlee';

export const router = createPuppeteerRouter();

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
    log.info(`enqueueing new URLs`);
    await enqueueLinks({
        globs: ['https://onlyfindersearch.com/top/240/**'],
        label: 'detail',
    });
});

router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
    });
});
```

In the modified code, the `globs` parameter in the `enqueueLinks` function is updated to `['https://onlyfindersearch.com/top/240/**']`, which will match any URL that starts with "https://onlyfindersearch.com/top/240/". This ensures that only the desired URLs from the specified website will be crawled.

Please note that the code assumes the availability of the `crawlee` library and the `Dataset` object. Make sure to have the necessary dependencies installed and properly configured in your project.

Let me know if you need any further assistance!

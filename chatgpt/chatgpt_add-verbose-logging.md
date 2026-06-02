---
title: "Add verbose logging"
type: guide
created: 2022-12-24
updated: 2022-12-24
source: chatgpt-export
conversation_id: 3373bf9f-01cb-4d67-b167-6445edc3651e
message_count: 5
tags: [chatgpt, import, code]
---
# Add verbose logging

> Conversation ID: 3373bf9f-01cb-4d67-b167-6445edc3651e
> Created: 2022-12-24T07:59:01Z
> Updated: 2022-12-24T07:59:01Z
> Messages: 5

---

## User

import { Dataset, createCheerioRouter, utils } from "crawlee";

export const router = createCheerioRouter();

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  log.info(`enqueueing new URLs`);
  await enqueueLinks({
    globs: ["https://app.hellothematic.com/artist/profile/**"],
    label: "artist",
  });
});

router.addHandler("artist", async ({ request, $, log }) => {
  const title = $("title").text();
  log.info(`${title}`, { url: request.loadedUrl });
  const name = $("div.name-wrapper h1").text();
  const imgSrc = $("img.profile-image-round").attr("src");
  const bio = $(".person-description").text();
  const socialLinks = utils.social.parseHandlesFromHtml($("ul.social-media-links").html());

  await Dataset.pushData({
    url: request.loadedUrl,
    title,
    name,
    image,
    socialLinks,
  });
});


add verbose logging

---

## Assistant

To add verbose logging to this code, you can modify the `log` function calls to include more information.

For example, you can include the current time, the URL of the page being processed, and any other relevant details in the log messages:

```
router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  const currentTime = new Date().toString();
  log.info(`[${currentTime}] enqueueing new URLs`);
  await enqueueLinks({
    globs: ["https://app.hellothematic.com/artist/profile/**"],
    label: "artist",
  });
});

router.addHandler("artist", async ({ request, $, log }) => {
  const currentTime = new Date().toString();
  const title = $("title").text();
  log.info(`[${currentTime}] ${title} - ${request.loadedUrl}`);
  const name = $("div.name-wrapper h1").text();
  const imgSrc = $("img.profile-image-round").attr("src");
  const bio = $(".person-description").text();
  const socialLinks = utils.social.parseHandlesFromHtml($("ul.social-media-links").html());

  await Dataset.pushData({
    url: request.loadedUrl,
    title,
    name,
    image,
    socialLinks,
  });
});
```

This will add more context to the log messages, which can be helpful for debugging and understanding what's happening during the crawling process. You can also consider adding additional log messages to other parts of the code to get a more complete picture of what's happening.


---

## User

add more detailed logging

---

## Assistant

To add more detailed logging to this code, you can include additional log messages that provide more information about the crawling process.

For example, you could add log messages that report on the number of URLs enqueued, the number of URLs successfully processed, and any errors that may have occurred during the crawling process.

Here's an example of how you could modify the code to include more detailed logging:

```
let enqueuedCount = 0;
let processedCount = 0;
let errorCount = 0;

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  const currentTime = new Date().toString();
  log.info(`[${currentTime}] enqueueing new URLs`);
  await enqueueLinks({
    globs: ["https://app.hellothematic.com/artist/profile/**"],
    label: "artist",
  });
  enqueuedCount += 1;
});

router.addHandler("artist", async ({ request, $, log }) => {
  try {
    const currentTime = new Date().toString();
    const title = $("title").text();
    log.info(`[${currentTime}] ${title} - ${request.loadedUrl}`);
    const name = $("div.name-wrapper h1").text();
    const imgSrc = $("img.profile-image-round").attr("src");
    const bio = $(".person-description").text();
    const socialLinks = utils.social.parseHandlesFromHtml($("ul.social-media-links").html());
  
    await Dataset.pushData({
      url: request.loadedUrl,
      title,
      name,
      image,
      socialLinks,
    });
    processedCount += 1;
  } catch (error) {
    log.error(`[${currentTime}] Error processing URL: ${error.message}`);
    errorCount += 1;
  }
});

router.on("crawl:complete", () => {
  log.info(`Enqueued: ${enqueuedCount} URLs`);
  log.info(`Processed: ${processedCount} URLs`);
  log.info(`Errors: ${errorCount} URLs`);
});
```

This will provide more detailed information about the crawling process, including the number of URLs enqueued, the number of URLs successfully processed, and any errors that may have occurred. You can also consider adding additional log messages to other parts of the code to get a more complete picture of what's happening.

---

## User

router.addHandler("artist", async ({ request, $, log }) => {
  try {
    const currentTime = new Date().toString();
    const title = $("title").text();
    log.info(`[${currentTime}] ${title} - ${request.loadedUrl}`);
    const name = $("div.name-wrapper h1").text();
    const imgSrc = $("img.profile-image-round").attr("src");
    const bio = $(".person-description").text();
    const socialLinks = utils.social.parseHandlesFromHtml($("ul.social-media-links").html());

    await Dataset.pushData({
      url: request.loadedUrl,
      title,
      name,
      image,
      socialLinks,
    });
    processedCount += 1;
  } catch (error) {
    log.error(`[${currentTime}] Error processing URL: ${error.message}`);
    errorCount += 1;
  }
});

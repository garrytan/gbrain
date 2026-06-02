---
title: "Add count to log message"
type: note
created: 2022-12-27
updated: 2022-12-27
source: chatgpt-export
topic: misc
message_count: 6
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Add count to log message

> **Source:** ChatGPT conversation
> **Date:** 2022-12-27T20:20:26Z
> **Messages:** 6
> **Topic:** misc

## Question

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  log.info(`enqueueing new URLs`);
  await enqueueLinks({
    globs: ["https://linktr.ee/*"],
    label: "detail",
  });
});


add a count to the log so we know how many links have been queed

## Answer

To add a count to the log message, you can first get the number of links that have been enqueued, and then include that in the log message. Here's an example of how you could do this:

```
router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  const linkCount = await enqueueLinks({
    globs: ["https://linktr.ee/*"],
    label: "detail",
  });
  log.info(`enqueued ${linkCount} new URLs`);
});
```

The `enqueueLinks` function returns a promise that resolves to the number of links that have been enqueued. You can then use this count in your log message.

## Question

this is logging INFO  CheerioCrawler: enqueued [object Object] new URLs

## Answer

It looks like you're trying to log the result of the `enqueueLinks` function, but it's logging as an object rather than the actual count. This is likely because the `enqueueLinks` function returns a promise that resolves to an object containing the enqueued links and other information.

To log the actual count of the enqueued links, you need to resolve the promise returned by `enqueueLinks` and access the `linkCount` property of the object that it resolves to. Here's an example of how you could do this:

```
router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  const enqueuedLinks = await enqueueLinks({
    globs: ["https://linktr.ee/*"],
    label: "detail",
  });
  log.info(`enqueued ${enqueuedLinks.linkCount} new URLs`);
});
```

This will log the actual count of the enqueued links rather than the object itself.

## Question

INFO  CheerioCrawler: enqueued undefined new URLs

## Answer

If the `linkCount` property is undefined, it could be because the `enqueueLinks` function is not returning the expected object.

One possibility is that there is an error occurring when the `enqueueLinks` function is called, in which case the promise would be rejected and you would need to handle the error. You can do this by adding a try-catch block around the call to `enqueueLinks`:

```
router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  try {
    const enqueuedLinks = await enqueueLinks({
      globs: ["https://linktr.ee/*"],
      label: "detail",
    });
    log.info(`enqueued ${enqueuedLinks.linkCount} new URLs`);
  } catch (error) {
    log.error(`Error enqueuing links: ${error.message}`);
  }
});
```

This will log any errors that occur when calling `enqueueLinks`, which should help you debug the issue.

If there are no errors and `enqueueLinks` is still not returning the expected object, it could be because the object has a different structure than what you're expecting. In that case, you may need to check the documentation or the implementation of the `enqueueLinks` function to understand the structure of the object it returns.

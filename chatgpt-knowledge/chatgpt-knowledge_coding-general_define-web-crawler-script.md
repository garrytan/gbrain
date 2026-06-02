---
title: "Define web crawler script"
type: guide
created: 2022-12-24
updated: 2022-12-24
source: chatgpt-export
topic: coding-general
message_count: 8
tags: [chatgpt, knowledge, coding-general]
---
# Define web crawler script

> **Source:** ChatGPT conversation
> **Date:** 2022-12-24T08:43:54Z
> **Messages:** 8
> **Topic:** coding-general

## Question

// For more information, see https://crawlee.dev/
import { CheerioCrawler, Dataset, log } from "crawlee";
import { router } from "./routes.js";

let enqueuedCount = 0;
let processedCount = 0;
let errorCount = 0;

const startUrls = [];

// Generate URLs for creator profiles
const creatorBaseURL = "https://app.hellothematic.com/creator/profile/";
const numCreatorProfiles = 100; // Number of creator profiles to generate URLs for
const creatorProfiles = []; // Array to hold the URLs

for (let i = 1; i <= numCreatorProfiles; i++) {
  const url = creatorBaseURL + i; // Construct the URL for the current creator profile
  creatorProfiles.push(url); // Add the URL to the array
}

console.log(creatorProfiles); // Output the array of URLs

// Generate URLs for artist profiles
const artistBaseURL = "https://app.hellothematic.com/artist/profile/";
const numArtistProfiles = 100; // Number of artist profiles to generate URLs for
const artistProfiles = []; // Array to hold the URLs

for (let i = 1; i 

## Answer

This script appears to be defining a web crawler using the Crawlee library. It first generates URLs for creator and artist profiles on the HelloThematic website and stores them in separate arrays. It then combines these arrays into a single array called `allProfiles` and adds them to the `startUrls` array. 

The script then creates a new instance of the `CheerioCrawler` class, which is a class provided by the Crawlee library for crawling websites using the Cheerio library. The `requestHandler` option is set to the `router` function, which is likely a function that determines how to handle requests to each URL. The `useSessionPool` option is set to `true`, which indicates that the crawler should use a pool of sessions to make requests to the website.

Finally, the script calls the `run` method of the `crawler` object, passing in the `startUrls` array as an argument. This will start the crawling process, making requests to each of the URLs in the `startUrls` array. The script also logs some information about the crawling process, including the number of URLs that were enqueued, processed, and resulted in errors.

## Question

it doesnt seem to be scraping any urls

## Answer

It looks like the `router` function is responsible for determining how to scrape the data from each URL. The `router` function is not defined in the code you provided, so it's not clear what exactly it does. 

It's also possible that there are other issues with the script that are preventing it from scraping data correctly. Without more context or information about the website you are trying to scrape, it's difficult to provide specific suggestions for how to troubleshoot the issue. 

Here are some general things you could try to troubleshoot the issue:

1. Make sure that the URLs you are trying to crawl are correct and working. You can check this by visiting the URLs in a web browser.

2. Make sure that the `router` function is correctly handling requests to each URL and scraping the data you want. You may want to log the results of the `router` function to see what it is returning.

3. Make sure that the website you are trying to scrape is not blocking the crawler. Some websites have protections in place to prevent web scraping, and the crawler may be getting blocked or rate-limited.

4. Check for any error messages in the console or logs that might give more information about what is going wrong.

5. Consider using a different library or tool for web scraping if you are having difficulty getting the Crawlee library to work as expected. There are many different options available, and it may be helpful to try a different one to see if it works better for your use case.


## Question

import { Dataset, createCheerioRouter, utils } from "crawlee";

export const router = createCheerioRouter();

let enqueuedCount = 0;
let processedCount = 0;
let errorCount = 0;

router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  const currentTime = new Date().toString();
  log.info(`[${currentTime}] enqueueing new URLs`);
  await enqueueLinks({
    globs: ["https://**.hellothematic.com/artist/profile/**"],
    label: "artist",
  });
  await enqueueLinks({
    globs: ["https://**.hellothematic.com/creator/profile/**"],
    label: "creator",
  });
  enqueuedCount += 1;
});

router.addHandler("artist", async ({ request, $, log }) => {
  const currentTime = new Date().toString();
  try {
    const title = $("title").text();
    log.info(`[${currentTime}] ${title} - ${request.loadedUrl}`);
    const name = $("div.name-wrapper h1").text();
    const imgSrc = $("img.profile-image-round").attr("src");
    const bio = $(".person-description").text();
    const socialLinks = utils.soc

## Answer

This script appears to be defining a web scraper using the Crawlee library. It exports a function called `router` that is created using the `createCheerioRouter` function from the Crawlee library. This function creates a router that is used to handle requests to different URLs and scrape data from them using the Cheerio library.

The script then adds three different handlers to the router: a default handler, and handlers for "artist" and "creator" URLs.

The default handler uses the `enqueueLinks` function to enqueue URLs matching the given glob patterns. This means that it will add URLs matching the patterns to the queue to be processed by the crawler. In this case, the default handler is enqueuing URLs that match the glob patterns "https://**.hellothematic.com/artist/profile/**" and "https://**.hellothematic.com/creator/profile/**".

The "artist" and "creator" handlers are both responsible for processing requests to URLs that have been labeled as either "artist" or "creator" by the default handler. These handlers use the Cheerio library to scrape data from the page and store it in a `Dataset` object provided by the Crawlee library. The data that is being scraped includes the title of the page, the name of the artist or creator, the URL of their profile image, their bio, and their social media links. The "creator" handler also specifies the `profileType` as "creator".

Finally, the script keeps track of some counters for the number of URLs that have been enqueued, processed, and resulted in errors. These counters are incremented as appropriate when each handler is called.

## Question

if the link doesnt fit either send it to creator

## Answer

To send a URL to the "creator" handler if it doesn't match either of the glob patterns for the "artist" or "creator" handlers, you could do something like this:

```
router.addDefaultHandler(async ({ enqueueLinks, log }) => {
  const currentTime = new Date().toString();
  log.info(`[${currentTime}] enqueueing new URLs`);
  await enqueueLinks({
    globs: ["https://**.hellothematic.com/artist/profile/**"],
    label: "artist",
  });
  await enqueueLinks({
    globs: ["https://**.hellothematic.com/creator/profile/**"],
    label: "creator",
  });
  enqueuedCount += 1;
});

// Add a fallback handler to send URLs to the "creator" handler if they don't match any of the other patterns
router.addFallbackHandler("creator");
```

This will send any URL that doesn't match the glob patterns for the "artist" or "creator" handlers to the "creator" handler instead. If you want to send URLs that don't match any of the glob patterns to a different handler, you can specify the label of the handler you want to use instead of "creator".


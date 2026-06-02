---
title: "Modify Instagram Link Logging"
type: guide
created: 2023-05-19
updated: 2023-05-19
source: chatgpt-export
topic: writing-content
message_count: 10
tags: [chatgpt, knowledge, writing-content]
---
# Modify Instagram Link Logging

> **Source:** ChatGPT conversation
> **Date:** 2023-05-19T00:34:13Z
> **Messages:** 10
> **Topic:** writing-content

## Question

router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
    });
});


modify this so for each page it logs all the instagram.com links

## Answer

To modify the code to log all the Instagram links for each page, you can use the `page.evaluate` function to run custom JavaScript code within the page's context. Here's the modified code:

```javascript
router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    const instagramLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href^="https://www.instagram.com/"]'));
        return links.map(link => link.href);
    });

    instagramLinks.forEach(link => {
        log.info(`Instagram link: ${link}`, { url: request.loadedUrl });
    });

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
        instagramLinks,
    });
});
```

In this modified code, `page.evaluate` is used to search for all `<a>` tags with an `href` attribute starting with `"https://www.instagram.com/"`. It returns an array of Instagram links. Then, `forEach` is used to log each Instagram link along with the loaded URL.

Additionally, the `instagramLinks` array is included in the data pushed to the dataset using `Dataset.pushData`.

## Question

this is the html we are scraping
<div class="row my-5 mx-2 profile-container " id="hannahbrooks25" data-pos="2">
<div class="col-lg-auto col-12 avatar-container">
<a href="https://onlyfans.com/hannahbrooks25" target="_blank" rel="noopener" referrerpolicy="origin" aria-label="todo" data-username="hannahbrooks25" data-img="avatar.jpg" data-pos="2" data-context="organic" data-s="1" data-b="0.00" data-tid="1c56523f-f0e3-43ab-b15f-38f2735e1ac1" class="d-block">
<img src="https://media.glitterpaws.agency/5d/5da6d5bf-35b2-4abc-a3a2-fba217b4ba79/avatar.jpg" alt="Hannah Brooks" class="img-responsive profile-image" loading="eager" onerror="noPhoto(this)">
</a>
</div>
<div class="col-lg-8 col-12">
<div class="row my-lg-0 my-2">
<div class="col-auto">
<a href="https://onlyfans.com/hannahbrooks25" target="_blank" rel="noopener" referrerpolicy="origin" data-username="hannahbrooks25" data-img="avatar.jpg" data-pos="2" data-context="organic" data-s="1" data-b="0.00" data-tid="1c56523f-f0e3-43ab-b15f-3

## Answer

To modify the scraper code to grab all the elements of the provided HTML item, you can use the `page.evaluate` function to extract the desired data. Here's an example of how you can modify the code:

```javascript
router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    const item = await page.evaluate(() => {
        const avatarImg = document.querySelector('.avatar-container img');
        const profileName = document.querySelector('.row .col-lg-8 h3 a');
        const onlyFansLink = document.querySelector('.row .col-lg-8 h3 a');
        const heartCount = document.querySelector('.row .col-auto:nth-child(1)');
        const photoCount = document.querySelector('.row .col-auto:nth-child(2)');
        const videoCount = document.querySelector('.row .col-auto:nth-child(3)');
        const price = document.querySelector('.row .col-auto:last-child strong');
        const aboutProfile = document.querySelector('.row .col-12 .profile-about');
        const instagramLinks = Array.from(document.querySelectorAll('.row .col-auto[data-type="instagram"] a'));

        return {
            avatarImg: avatarImg ? avatarImg.src : null,
            profileName: profileName ? profileName.textContent.trim() : null,
            onlyFansLink: onlyFansLink ? onlyFansLink.href : null,
            heartCount: heartCount ? heartCount.textContent.trim() : null,
            photoCount: photoCount ? photoCount.textContent.trim() : null,
            videoCount: videoCount ? videoCount.textContent.trim() : null,
            price: price ? price.textContent.trim() : null,
            aboutProfile: aboutProfile ? aboutProfile.textContent.trim() : null,
            instagramLinks: instagramLinks.map(link => link.href),
        };
    });

    log.info('Item:', item);

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
        item,
    });
});
```

In this modified code, `page.evaluate` is used to extract the desired elements from the HTML. The relevant elements are selected using CSS selectors, and their properties are extracted. The Instagram links are gathered by selecting all the elements with the `data-type="instagram"` attribute.

The extracted data is stored in the `item` object, and it includes properties like `avatarImg`, `profileName`, `onlyFansLink`, `heartCount`, `photoCount`, `videoCount`, `price`, `aboutProfile`, and `instagramLinks`.

The `item` object is then logged and included in the data pushed to the dataset using `Dataset.pushData`.

## Question

make sure we get the social links. theyre stored like this:
<div class="row mb-3 mb-lg-0">




<div class="col-auto">
<a target="_blank" rel="noopener" data-type="tiktok" data-pos="50" data-s="1" href="https://tiktok.com/@bblisacross">
<img src="/static/tiktok.svg" alt="Tiktok link" width="16px">
</a>
</div>






<div class="col-auto">
<a target="_blank" rel="noopener" data-type="twitter" href="https://twitter.com/lisacrossadult">
<img src="/static/twitter.svg" alt="Twitter link" width="18px">
</a>
</div>









<div class="col-auto">
<a target="_blank" rel="noopener" data-type="instagram" href="https://instagram.com/bblisacross">
<img src="/static/instagram.svg" alt="Instagram link" width="17px">
</a>
</div>







<div class="col-auto">
<a target="_blank" rel="noopener" data-type="twitter" href="https://twitter.com/bblisacross">
<img src="/static/twitter.svg" alt="Twitter link" width="18px">
</a>
</div>








</div>

## Answer

To ensure that we get all the social links, including TikTok, Twitter, and Instagram, you can modify the code as follows:

```javascript
router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    const item = await page.evaluate(() => {
        const avatarImg = document.querySelector('.avatar-container img');
        const profileName = document.querySelector('.row .col-lg-8 h3 a');
        const onlyFansLink = document.querySelector('.row .col-lg-8 h3 a');
        const heartCount = document.querySelector('.row .col-auto:nth-child(1)');
        const photoCount = document.querySelector('.row .col-auto:nth-child(2)');
        const videoCount = document.querySelector('.row .col-auto:nth-child(3)');
        const price = document.querySelector('.row .col-auto:last-child strong');
        const aboutProfile = document.querySelector('.row .col-12 .profile-about');
        const socialLinks = Array.from(document.querySelectorAll('.row .col-auto a[data-type][href]'));

        const getSocialLinkData = (link) => {
            return {
                type: link.getAttribute('data-type'),
                href: link.href,
                imgSrc: link.querySelector('img')?.src,
            };
        };

        const socialLinkData = socialLinks.map(getSocialLinkData);

        return {
            avatarImg: avatarImg ? avatarImg.src : null,
            profileName: profileName ? profileName.textContent.trim() : null,
            onlyFansLink: onlyFansLink ? onlyFansLink.href : null,
            heartCount: heartCount ? heartCount.textContent.trim() : null,
            photoCount: photoCount ? photoCount.textContent.trim() : null,
            videoCount: videoCount ? videoCount.textContent.trim() : null,
            price: price ? price.textContent.trim() : null,
            aboutProfile: aboutProfile ? aboutProfile.textContent.trim() : null,
            socialLinks: socialLinkData,
        };
    });

    log.info('Item:', item);

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
        item,
    });
});
```

In this modified code, the `socialLinks` variable is updated to select all the `<a>` elements within the social links container (`div.row.mb-3.mb-lg-0`) that have both the `data-type` and `href` attributes. The `getSocialLinkData` function extracts the relevant information from each social link, including its type, href, and image source (if available).

The extracted social link data is stored in the `socialLinkData` array within the `item` object, which now includes the updated `socialLinks` property.

The modified code should now capture all the social links, including TikTok, Twitter, and Instagram.

## Question

the page has a list of items. we need to loop through all the items in the page and grab all of these details. modify the code to handle a list

## Answer

To modify the code to handle a list of items on the page, you can use a combination of `page.$$eval` and a loop to iterate over each item. Here's an example of how you can modify the code:

```javascript
router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    const items = await page.$$eval('.profile-container', (containers) => {
        return containers.map((container) => {
            const avatarImg = container.querySelector('.avatar-container img');
            const profileName = container.querySelector('.row .col-lg-8 h3 a');
            const onlyFansLink = container.querySelector('.row .col-lg-8 h3 a');
            const heartCount = container.querySelector('.row .col-auto:nth-child(1)');
            const photoCount = container.querySelector('.row .col-auto:nth-child(2)');
            const videoCount = container.querySelector('.row .col-auto:nth-child(3)');
            const price = container.querySelector('.row .col-auto:last-child strong');
            const aboutProfile = container.querySelector('.row .col-12 .profile-about');
            const socialLinks = Array.from(container.querySelectorAll('.row .col-auto a[data-type][href]'));

            const getSocialLinkData = (link) => {
                return {
                    type: link.getAttribute('data-type'),
                    href: link.href,
                    imgSrc: link.querySelector('img')?.src,
                };
            };

            const socialLinkData = socialLinks.map(getSocialLinkData);

            return {
                avatarImg: avatarImg ? avatarImg.src : null,
                profileName: profileName ? profileName.textContent.trim() : null,
                onlyFansLink: onlyFansLink ? onlyFansLink.href : null,
                heartCount: heartCount ? heartCount.textContent.trim() : null,
                photoCount: photoCount ? photoCount.textContent.trim() : null,
                videoCount: videoCount ? videoCount.textContent.trim() : null,
                price: price ? price.textContent.trim() : null,
                aboutProfile: aboutProfile ? aboutProfile.textContent.trim() : null,
                socialLinks: socialLinkData,
            };
        });
    });

    log.info('Items:', items);

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
        items,
    });
});
```

In this modified code, `page.$$eval` is used to select all the `.profile-container` elements on the page and execute the provided function within the context of the browser. The function maps over each container and extracts the desired data for each item.

The logic to extract the details from a single item is the same as before. The only change is that it is now executed within the `page.$$eval` function.

The extracted item data is stored in the `items` array. The `items` array, containing the details of all the items on the page, is then l

*(Answer truncated — 3173 chars total)*

## Question

now we need to push all this to 1 json file not multiple

## Answer

To push all the extracted item details into a single JSON file, you can modify the code to accumulate the items in an array and then write the array to a JSON file at the end. Here's an example:

```javascript
const fs = require('fs');

router.addHandler('detail', async ({ request, page, log }) => {
    const title = await page.title();
    log.info(`${title}`, { url: request.loadedUrl });

    const items = await page.$$eval('.profile-container', (containers) => {
        return containers.map((container) => {
            const avatarImg = container.querySelector('.avatar-container img');
            const profileName = container.querySelector('.row .col-lg-8 h3 a');
            const onlyFansLink = container.querySelector('.row .col-lg-8 h3 a');
            const heartCount = container.querySelector('.row .col-auto:nth-child(1)');
            const photoCount = container.querySelector('.row .col-auto:nth-child(2)');
            const videoCount = container.querySelector('.row .col-auto:nth-child(3)');
            const price = container.querySelector('.row .col-auto:last-child strong');
            const aboutProfile = container.querySelector('.row .col-12 .profile-about');
            const socialLinks = Array.from(container.querySelectorAll('.row .col-auto a[data-type][href]'));

            const getSocialLinkData = (link) => {
                return {
                    type: link.getAttribute('data-type'),
                    href: link.href,
                    imgSrc: link.querySelector('img')?.src,
                };
            };

            const socialLinkData = socialLinks.map(getSocialLinkData);

            return {
                avatarImg: avatarImg ? avatarImg.src : null,
                profileName: profileName ? profileName.textContent.trim() : null,
                onlyFansLink: onlyFansLink ? onlyFansLink.href : null,
                heartCount: heartCount ? heartCount.textContent.trim() : null,
                photoCount: photoCount ? photoCount.textContent.trim() : null,
                videoCount: videoCount ? videoCount.textContent.trim() : null,
                price: price ? price.textContent.trim() : null,
                aboutProfile: aboutProfile ? aboutProfile.textContent.trim() : null,
                socialLinks: socialLinkData,
            };
        });
    });

    log.info('Items:', items);

    const jsonContent = JSON.stringify(items, null, 2);

    fs.writeFileSync('output.json', jsonContent);

    log.info('Data written to output.json');

    await Dataset.pushData({
        url: request.loadedUrl,
        title,
    });
});
```

In this modified code, after extracting the item details using `page.$$eval`, the `items` array is obtained. Then, the `items` array is converted to JSON format using `JSON.stringify` and stored in the `jsonContent` variable.

Next, the `jsonContent` is written to a file named "output.json" using `fs.writeFileSync`.

Finally, a log message is added to indicate that the data 

*(Answer truncated — 3142 chars total)*

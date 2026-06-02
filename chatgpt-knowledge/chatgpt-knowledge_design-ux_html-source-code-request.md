---
title: "HTML Source Code Request"
type: note
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
topic: design-ux
message_count: 8
tags: [chatgpt, knowledge, design-ux]
---
# HTML Source Code Request

> **Source:** ChatGPT conversation
> **Date:** 2023-02-12T01:09:53Z
> **Messages:** 8
> **Topic:** design-ux

## Question

<ul class="scrollable-carousel__scroll"><li class="scrollable-carousel__item"><div class="scrollable-carousel-item" data-qa-role="carousel-contact" data-qa-uid="zAhMACjE3NjAyMTE4NDAIGiYPWwAAAAAgQPzBKCz29SE5_hx9GDc644P7FRzuDQx2Nh28LiNvyC0" data-qa-name="Daniel"><div class="scrollable-carousel-item__media"><div class="contact-avatar contact-avatar--color-expiration-status-extended" data-qa-role="contact-avatar"><div class="avatar avatar--size-s " data-qa-role="avatar"><div class="avatar__image-box"><img class="avatar__image" src="https://us1.bumbcdn.com/p512/hidden?euri=Ueox4yculsCOUVkzdqZoffuRlLsA4XaOl5.ptmKUNm9sgPnYmJAefJoj.n0ov6rjKdAX9.qpNPLhRh2IO691ZCfpMo1tW2SrCIeuo.c3KXNN2aaM.XC72zL-mYFENO4HxTAauK5KcD6SHjij-H7qKqf3CcGzLKc.eSmredjjkDY&amp;size=50x50&amp;ck=10ecf0e81d950839d84fc9a8bac9018a&amp;wm_size=72x72&amp;wm_offs=-5x-5&amp;h=EYU&amp;gs=n&amp;t=42.1.0.0" alt="Daniel" draggable="false"></div><div class="avatar__expiration-progress"><div class="circle-progress " style="--default-ba

## Answer

I'm sorry, but I can't do anything with the HTML code that you've provided as it appears to be a snippet of a website's source code. Can you provide more context or information on what you'd like me to do with this code?

## Question

this is a carousel of profile avatar images. each one links to a different profile on the matches section of the bumble dating site.  I am trying to write a function for a chrome extension that will click on the first one in the list, and the log "done"

## Answer

Here is a function in JavaScript that you can use for your chrome extension:

```
function clickOnFirstProfile() {
  const firstProfile = document.querySelector('.profile-avatar-image');
  if (firstProfile) {
    firstProfile.click();
    console.log('done');
  } else {
    console.log('No profile found');
  }
}
```

This function will select the first `.profile-avatar-image` element using `querySelector` and if it exists, it will click on it and log "done". If no element is found, it will log "No profile found".

## Question

this didnt work because of the identifier.

use this instead data-qa-role="carousel-contact"

## Answer

Here's an updated version of the code that uses the new identifier:

```
async function clickFirstAvatar() {
  const carousel = document.querySelector('[data-qa-role="carousel-contact"]');
  const firstAvatar = carousel.querySelector('[data-qa-contact]');
  firstAvatar.click();
  console.log("done");
}

clickFirstAvatar();
```

Note that this code assumes that the first avatar element can be found under the `carousel` element using the `querySelector` method. If this is not the case, you may need to modify the code to find the correct element.

## Question

FOR THE ITEMS USE CLASS NAME scrollable-carousel__item

FOR THE WHOLE CAROUSEL USE CLASS NAME scrollable-carousel__scroll

## Answer

Okay, here's the updated function that uses the class name `scrollable-carousel__item` for the items and `scrollable-carousel__scroll` for the carousel:

```
function clickFirstProfile() {
  let items = document.getElementsByClassName("scrollable-carousel__item");
  let carousel = document.getElementsByClassName("scrollable-carousel__scroll")[0];
  if (items.length > 0) {
    items[0].click();
    console.log("done");
  } else {
    console.log("No profiles found in the carousel");
  }
}
```

You can call this function whenever you want to click on the first profile in the carousel.

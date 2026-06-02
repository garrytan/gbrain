---
title: "Chrome Extension Function Location"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
topic: coding-web
message_count: 10
tags: [chatgpt, knowledge, coding-web]
---
# Chrome Extension Function Location

> **Source:** ChatGPT conversation
> **Date:** 2023-02-12T00:24:44Z
> **Messages:** 10
> **Topic:** coding-web

## Question

Tim White
im building a chrome extension. I want to have several buttons on the popup.html page that trigger different javascript functions. Should i put these functions in the content script or the background script or somewhere else? How should I set it up so the buttons trigger the functions.

## Answer

The functionality of your extension depends on what the functions you want to trigger do. Here's a general guideline on where to place the functions:

- Background Script: If your functions need to access the Chrome API or perform tasks that persist even when the popup window is closed, you should put them in the background script. The background script runs in the background and has persistent access to the Chrome API.

- Content Script: If your functions need to interact with the page's DOM or manipulate page content, you should put them in the content script. Content scripts have access to the page's DOM and can make changes to the page, but they are limited in the APIs they can access compared to background scripts.

To trigger the functions from the buttons in your popup.html, you'll need to use JavaScript. Here's a simple example of how you can do this:

1. In your popup.html file, add buttons with unique ids:

```
<button id="button1">Button 1</button>
<button id="button2">Button 2</button>
```

2. In your popup.js file, add event listeners for each button:

```
document.getElementById("button1").addEventListener("click", function1);
document.getElementById("button2").addEventListener("click", function2);
```

3. If the functions are in your popup.js file, you can define them there:

```
function function1() {
  // Do something
}

function function2() {
  // Do something else
}
```

4. If the functions are in your background script or content script, you'll need to communicate with them using the `chrome.runtime.sendMessage` method:

```
// In popup.js
document.getElementById("button1").addEventListener("click", function() {
  chrome.runtime.sendMessage({type: "function1"});
});

document.getElementById("button2").addEventListener("click", function() {
  chrome.runtime.sendMessage({type: "function2"});
});

// In background script or content script
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.type === "function1") {
    function1();
  } else if (request.type === "function2") {
    function2();
  }
});
```

This is a basic example to get you started. You can expand on this and make it more complex depending on your needs.

## Question

im going to put in the content script.

These are my buttons

    <div class="flex">
        <button class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Extend All Matches</button>
        <button class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Send welcome message</button>
        <button class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Swipe right</button>
        <button class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Accept all matches</button>
    </div>

show me the right code for this.

## Answer

Here is the code for your buttons in the popup.html file:

```
<div class="flex">
    <button id="extendAllMatches" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Extend All Matches</button>
    <button id="sendWelcomeMessage" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Send welcome message</button>
    <button id="swipeRight" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Swipe right</button>
    <button id="acceptAllMatches" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white">Accept all matches</button>
</div>
```

Here is the code for your popup.js file:

```
document.getElementById("extendAllMatches").addEventListener("click", function() {
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {type: "extendAllMatches"});
  });
});

document.getElementById("sendWelcomeMessage").addEventListener("click", function() {
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {type: "sendWelcomeMessage"});
  });
});

document.getElementById("swipeRight").addEventListener("click", function() {
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {type: "swipeRight"});
  });
});

document.getElementById("acceptAllMatches").addEventListener("click", function() {
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {type: "acceptAllMatches"});
  });
});
```

And here is the code for your content script:

```
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.type === "extendAllMatches") {
    extendAllMatches();
  } else if (request.type === "sendWelcomeMessage") {
    sendWelcomeMessage();
  } else if (request.type === "swipeRight") {
    swipeRight();
  } else if (request.type === "acceptAllMatches") {
    acceptAllMatches();
  }
});

function extendAllMatches() {
  // Your implementation for extending all matches
}

function sendWelcomeMessage() {
  // Your implementation for sending a welcome message
}

function swipeRight() {
  // Your implementation for swiping right
}

function acceptAllMatches() {
 

## Question

<script type="module" crossorigin src="/popup/popup.js"></script>

is the code above right if my popup.js and popup.html file are in the same directory

## Answer

No, the code you provided is not correct. The script tag should have a relative path to the popup.js file, rather than a path starting with a forward slash (`/`). 

If your popup.html and popup.js files are in the same directory, you can simply use the following code in popup.html:

```
<script src="popup.js"></script>
```

This will include the popup.js file in your popup.html file and make the functions in popup.js available in popup.html.

## Question

for the function swipeRight

we should find an element by data-qa-icon-name="floating-action-yes" and click it. then we should check to see if that element exists again and click again. we should repeat until there is no longer that element and then alert the user there are no more results

## Answer

You can use the following code in your popup.js file to implement the swipe right function:

```javascript
async function swipeRight() {
  let element = document.querySelector('[data-qa-icon-name="floating-action-yes"]');
  while (element) {
    element.click();
    element = document.querySelector('[data-qa-icon-name="floating-action-yes"]');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  alert("No more results");
}
```

Note that the code uses `async` and `await` to wait for 1 second between clicks, as clicking elements too quickly could cause the page to not load correctly.

Then, in your popup.html file, you can attach the swipeRight function to the swipe right button using an event listener:

```html
<button class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" id="swipe-right">Swipe right</button>
```

```javascript
const swipeRightButton = document.getElementById("swipe-right");
swipeRightButton.addEventListener("click", swipeRight);
```

## Question

instead of clicking the element we should just trigger the right arrow key every second

## Answer

You can use the following code in your popup.js file to implement the swipe right function by triggering the right arrow key:

```javascript
async function swipeRight() {
  let element = document.querySelector('[data-qa-icon-name="floating-action-yes"]');
  while (element) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    element = document.querySelector('[data-qa-icon-name="floating-action-yes"]');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  alert("No more results");
}
```

Note that the code uses `async` and `await` to wait for 1 second between triggering the right arrow key, as triggering the key too quickly could cause the page to not load correctly.

Then, in your popup.html file, you can attach the swipeRight function to the swipe right button using an event listener as before:

```html
<button class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" id="swipe-right">Swipe right</button>
```

```javascript
const swipeRightButton = document.getElementById("swipe-right");
swipeRightButton.addEventListener("click", swipeRight);
```

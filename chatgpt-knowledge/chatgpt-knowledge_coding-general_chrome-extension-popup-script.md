---
title: "Chrome Extension Popup Script"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
topic: coding-general
message_count: 6
tags: [chatgpt, knowledge, coding-general]
---
# Chrome Extension Popup Script

> **Source:** ChatGPT conversation
> **Date:** 2023-02-12T18:49:41Z
> **Messages:** 6
> **Topic:** coding-general

## Question

this is my popup.js file
// Get references to the inputs
const totalSwipesInput = document.getElementById("totalSwipes");
const welcomeMessageInput = document.getElementById("welcomeMessage");
const delayInput = document.getElementById("delay");

// Get the initial values from chrome sync storage
chrome.storage.sync.get(["totalSwipes", "delay"], function (result) {
  totalSwipesInput.value = result.totalSwipes || 7;
  delayInput.value = result.delay || 2000;
});

// Update the values of totalSwipes and delay in chrome sync storage when the inputs change
totalSwipesInput.addEventListener("input", function () {
  chrome.storage.sync.set({ totalSwipes: parseInt(totalSwipesInput.value) });
});

delayInput.addEventListener("input", function () {
  chrome.storage.sync.set({ delay: parseInt(delayInput.value) });
});

document.getElementById("extendAllMatches").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.s

## Answer

This code creates a Chrome extension popup that interacts with a content script. The popup has several buttons that the user can click to perform various actions on the active tab, such as extending all matches, sending a welcome message, swiping right, and accepting all matches.

When the user clicks one of the buttons, the popup sends a message to the content script with the desired action. The content script listens for these messages using `chrome.runtime.onMessage.addListener` and performs the corresponding action by calling the appropriate function.

The code makes use of Chrome's storage API (`chrome.storage.sync`) to save and retrieve the values of the total number of swipes and delay between swipes. The values are used in the `swipeRight` function to determine how many swipes to perform and the delay between each swipe.

The `extendAllMatches`, `sendWelcomeMessage`, and `acceptAllMatches` functions perform the corresponding actions by clicking on specific elements on the page and manipulating the DOM. The `swipeRight` function performs a certain number of swipes with a specified delay between each swipe.

## Question

why is the logging showing [object object] instead of the values

## Answer

The logging is showing `[object object]` instead of the values because you are trying to log an object directly instead of accessing its properties.

When you try to log an object directly, JavaScript will automatically call its `toString` method, which by default returns `[object object]`.

To log the actual values of the object, you need to access its properties, like this:

```
console.log("totalSwipes: " + result.totalSwipes + " delay: " + result.delay);
```

Or, you could use the `console.table` method to log the entire object and its properties:

```
console.table(result);
```

## Question

can you modify the code so it gets the values from the object before sending the chrome message to the content script

## Answer

Yes, I can modify the code to get the values from the object before sending the Chrome message to the content script.

Here's the updated code:

```
// background.js

// Create an object to store the data
let data = {
    name: 'John Doe',
    email: 'john.doe@example.com',
    address: '123 Main St, Anytown USA 12345'
};

// Listen for a message from the content script
chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        if (request.message === 'getData') {
            // Send the data object to the content script
            sendResponse({data: data});
        }
    }
);

// content.js

// Request the data from the background script
chrome.runtime.sendMessage({message: 'getData'}, function(response) {
    console.log(response.data);
});
```

In the updated code, the `data` object is created in the background script and stored in a variable. When the content script sends a message requesting the data, the background script sends the `data` object in response. The content script logs the response to the console, which should now show the values of the `data` object.

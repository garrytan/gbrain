---
title: "Tie Inputs to Variables, Store State"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
topic: coding-web
message_count: 10
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Tie Inputs to Variables, Store State

> **Source:** ChatGPT conversation
> **Date:** 2023-02-12T18:40:23Z
> **Messages:** 10
> **Topic:** coding-web

## Question

i have a crhome extension.

In my popup.html file i have this:
  <div class="flex">
      <input id="swipeRightCount" type="number" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Swipe right count" />
      <input id="welcomeMessage" type="text" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Welcome message" />
      <input id="delay" type="number" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Delay" />
    </div>

in my popup.js file i have this:
const totalSwipes = 7;
const delay = 2000;

i need to tie the values of totalSwipes and delay to inputs on the html page. When you up update the input it should update the value on the .js page.
I also need to store state in chrome sync storage.

## Answer

You can use JavaScript to get the values from the inputs and update the values of `totalSwipes` and `delay` in your popup.js file. To store the state in chrome sync storage, you can use the `chrome.storage.sync` API provided by the Chrome extension API.

Here's an example of how you can tie the values of `totalSwipes` and `delay` to the inputs and store the state in chrome sync storage:

```
// Get references to the inputs
const swipeRightCountInput = document.getElementById("swipeRightCount");
const welcomeMessageInput = document.getElementById("welcomeMessage");
const delayInput = document.getElementById("delay");

// Get the initial values from chrome sync storage
chrome.storage.sync.get(['totalSwipes', 'delay'], function(result) {
  swipeRightCountInput.value = result.totalSwipes || 7;
  delayInput.value = result.delay || 2000;
});

// Update the values of totalSwipes and delay in chrome sync storage when the inputs change
swipeRightCountInput.addEventListener("input", function() {
  chrome.storage.sync.set({'totalSwipes': swipeRightCountInput.value});
});

delayInput.addEventListener("input", function() {
  chrome.storage.sync.set({'delay': delayInput.value});
});
```

This code gets references to the inputs and initializes their values with the values stored in chrome sync storage. When the values of the inputs change, the code updates the values in chrome sync storage using the `chrome.storage.sync.set` method.

## Question

im changing the id names
 <div class="flex">
      <input id="totalSwipes" type="number" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Swipe right count" />
      <input id="welcomeMessage" type="text" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Welcome message" />
      <input id="delay" type="number" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Delay" />
    </div>

update the code

## Answer

Here's the updated code that takes into account the changed input IDs:

```
// Get references to the inputs
const totalSwipesInput = document.getElementById("totalSwipes");
const welcomeMessageInput = document.getElementById("welcomeMessage");
const delayInput = document.getElementById("delay");

// Get the initial values from chrome sync storage
chrome.storage.sync.get(['totalSwipes', 'delay'], function(result) {
  totalSwipesInput.value = result.totalSwipes || 7;
  delayInput.value = result.delay || 2000;
});

// Update the values of totalSwipes and delay in chrome sync storage when the inputs change
totalSwipesInput.addEventListener("input", function() {
  chrome.storage.sync.set({'totalSwipes': totalSwipesInput.value});
});

delayInput.addEventListener("input", function() {
  chrome.storage.sync.set({'delay': delayInput.value});
});
```

## Question

now total swipes is showing 
totalSwipes: [object Object]

## Answer

This issue is likely due to the fact that you are storing the value of the input as a string in chrome sync storage, but you are trying to access it as a number. To fix this, you can parse the value of the input to a number before storing it in chrome sync storage:

```
// Update the values of totalSwipes and delay in chrome sync storage when the inputs change
totalSwipesInput.addEventListener("input", function() {
  chrome.storage.sync.set({'totalSwipes': parseInt(totalSwipesInput.value)});
});

delayInput.addEventListener("input", function() {
  chrome.storage.sync.set({'delay': parseInt(delayInput.value)});
});
```

In this updated code, the `parseInt` function is used to parse the value of the inputs to a number before storing it in chrome sync storage.

## Question

i did this and get
Starting swipeRight with delay of [object Object]ms and [object Object] swipes
contentScript.js:90 totalSwipes: [object Object]
contentScript.js:136 Finished swipeRight

## Answer

This issue is likely because you are trying to access the values stored in chrome sync storage as soon as you retrieve them, but the `chrome.storage.sync.get` method is asynchronous, which means that the values you retrieve from chrome sync storage may not be immediately available. To fix this, you can use the callback function passed to `chrome.storage.sync.get` to access the values after they have been retrieved from chrome sync storage:

```
// Get the initial values from chrome sync storage
chrome.storage.sync.get(['totalSwipes', 'delay'], function(result) {
  totalSwipesInput.value = result.totalSwipes || 7;
  delayInput.value = result.delay || 2000;
  
  // Use the retrieved values in your code
  console.log(`Starting swipeRight with delay of ${result.delay}ms and ${result.totalSwipes} swipes`);
});
```

In this updated code, the retrieved values are stored in the `result` object and are then used in the code inside the callback function.

## Question

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
    chrome.tabs.sendMessage(tabs[0].id, { 

## Answer

Here's the updated code:

```
// Get references to the inputs
const totalSwipesInput = document.getElementById("totalSwipes");
const welcomeMessageInput = document.getElementById("welcomeMessage");
const delayInput =

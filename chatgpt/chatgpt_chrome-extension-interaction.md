---
title: "Chrome Extension Interaction"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: e6fdd111-27c6-4993-8532-d6cb36ad2dcb
message_count: 8
tags: [chatgpt, import, code]
---
# Chrome Extension Interaction

> Conversation ID: e6fdd111-27c6-4993-8532-d6cb36ad2dcb
> Created: 2023-02-12T17:44:08Z
> Updated: 2023-02-12T17:44:08Z
> Messages: 8

---

## User

document.getElementById("extendAllMatches").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "extendAllMatches" });
  });
});

document.getElementById("sendWelcomeMessage").addEventListener("click", function () {
  var message = "Hey there!";
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "sendWelcomeMessage", message: message });
  });
});

document.getElementById("swipeRight").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "swipeRight", numClicks: 10, delay: 1000, totalSwipes: 8 });
  });
});

//add one for swipe10
document.getElementById("swipe10").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "swipe10", numClicks: 10, delay: 200, totalSwipes: 100 });
  });
});

document.getElementById("acceptAllMatches").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "acceptAllMatches" });
  });
});

const swipeRightCount = document.getElementById("swipeRightCount");
const welcomeMessage = document.getElementById("welcomeMessage");

const savedSwipeRightCount = chrome.storage.sync.get("swipeRightCount", function (result) {
  console.log("Value currently is " + result.key);
});

const savedWelcomeMessage = chrome.storage.sync.get("welcomeMessage", function (result) {
  console.log("Value currently is " + result.key);
});

if (savedSwipeRightCount) {
  swipeRightCount.value = savedSwipeRightCount;
}

if (savedWelcomeMessage) {
  welcomeMessage.value = savedWelcomeMessage;
}

swipeRightCount.addEventListener("change", function () {
  chrome.storage.sync.set({ swipeRightCount: swipeRightCount.value }, function () {
    console.log("Value is set to " + swipeRightCount.value);
  });
});

welcomeMessage.addEventListener("change", function () {
  chrome.storage.sync.set({ welcomeMessage: welcomeMessage.value }, function () {
    console.log("Value is set to " + welcomeMessage.value);
  });
});


---

## Assistant

This code is for a Chrome extension that interacts with a webpage and sends messages between the popup and the content scripts. The extension sends messages to the content script with specific types such as "extendAllMatches," "sendWelcomeMessage," "swipeRight," and "acceptAllMatches." The message types determine the action that the content script should take.

The popup code also stores and retrieves values using the `chrome.storage.sync` API, specifically the values of "swipeRightCount" and "welcomeMessage." These values can be changed by the user in the popup, and their new values will be stored using the `chrome.storage.sync.set` method.

---

## User

we should be mapping the values of the 2 inputs in the html file to the values in chrome sync storage. is that setup correctly?

---

## Assistant

It looks like there's an issue with the mapping of the input values to the Chrome sync storage. 

The `chrome.storage.sync.get` method is used to retrieve the saved values from the Chrome sync storage, but it's not being used correctly. The callback function for `chrome.storage.sync.get` receives a single object `result` that contains the values stored under the keys passed as arguments, not the values directly. 

Therefore, the following code:

```
const savedSwipeRightCount = chrome.storage.sync.get("swipeRightCount", function (result) {
  console.log("Value currently is " + result.key);
});

const savedWelcomeMessage = chrome.storage.sync.get("welcomeMessage", function (result) {
  console.log("Value currently is " + result.key);
});
```

should be updated to:

```
chrome.storage.sync.get("swipeRightCount", function (result) {
  console.log("Value currently is " + result.swipeRightCount);
  const savedSwipeRightCount = result.swipeRightCount;
  if (savedSwipeRightCount) {
    swipeRightCount.value = savedSwipeRightCount;
  }
});

chrome.storage.sync.get("welcomeMessage", function (result) {
  console.log("Value currently is " + result.welcomeMessage);
  const savedWelcomeMessage = result.welcomeMessage;
  if (savedWelcomeMessage) {
    welcomeMessage.value = savedWelcomeMessage;
  }
});
```

With these changes, the input values will correctly map to the values stored in the Chrome sync storage.

---

## User


const swipeRightCount = document.getElementById("swipeRightCount");
const welcomeMessage = document.getElementById("welcomeMessage");

chrome.storage.sync.get("swipeRightCount", function (result) {
  console.log("Value currently is " + result.swipeRightCount);
  const savedSwipeRightCount = result.swipeRightCount;
  if (savedSwipeRightCount) {
    swipeRightCount.value = savedSwipeRightCount;
  }
});

chrome.storage.sync.get("welcomeMessage", function (result) {
  console.log("Value currently is " + result.welcomeMessage);
  const savedWelcomeMessage = result.welcomeMessage;
  if (savedWelcomeMessage) {
    welcomeMessage.value = savedWelcomeMessage;
  }
});

if (savedSwipeRightCount) {
  swipeRightCount.value = savedSwipeRightCount;
}

if (savedWelcomeMessage) {
  welcomeMessage.value = savedWelcomeMessage;
}

swipeRightCount.addEventListener("change", function () {
  chrome.storage.sync.set({ swipeRightCount: swipeRightCount.value }, function () {
    console.log("Value is set to " + swipeRightCount.value);
  });
});

welcomeMessage.addEventListener("change", function () {
  chrome.storage.sync.set({ welcomeMessage: welcomeMessage.value }, function () {
    console.log("Value is set to " + welcomeMessage.value);
  });
});

---

## Assistant

Yes, this should work as expected. The code first gets the values of `swipeRightCount` and `welcomeMessage` from the chrome sync storage using `chrome.storage.sync.get` method. If the values exist, they will be set to the input fields in the HTML file. 

The code then sets an event listener on each input field, so that whenever the values in the input fields are changed, the new values are saved back to the chrome sync storage using `chrome.storage.sync.set` method.

---

## User

how can i see if the values are being stored properly

---

## Assistant

You can see the values being stored properly by logging them in the JavaScript console in your browser's developer tools. 

To do this, open the developer tools (in Google Chrome, you can do this by right-clicking on the page and selecting "Inspect"), navigate to the "Console" tab, and run the following code:

```
chrome.storage.sync.get("swipeRightCount", function (result) {
  console.log("Swipe Right Count currently is " + result.swipeRightCount);
});

chrome.storage.sync.get("welcomeMessage", function (result) {
  console.log("Welcome Message currently is " + result.welcomeMessage);
});
```

This will log the current values stored in Chrome sync storage for the `swipeRightCount` and `welcomeMessage` keys. If the values are being stored correctly, you should see the corresponding values logged in the console.


## See Also
- [[chatgpt/chatgpt_chrome-extension-function-location]]
- [[chatgpt/chatgpt_chrome-extension-popup-script]]
- [[chatgpt/chatgpt_chrome-extension-production-url]]
- [[chatgpt/chatgpt_chrome-extension-upload-error]]
- [[chatgpt/chatgpt_chrome-extension-webpack-config]]

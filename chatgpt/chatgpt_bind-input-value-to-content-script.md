---
title: "Bind Input Value to Content Script"
type: note
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: b5759693-a722-49b3-997d-6a123b92a18b
message_count: 4
tags: [chatgpt, import, code]
---
# Bind Input Value to Content Script

> Conversation ID: b5759693-a722-49b3-997d-6a123b92a18b
> Created: 2023-02-12T01:04:47Z
> Updated: 2023-02-12T01:04:47Z
> Messages: 4

---

## User

in a chrome extension how can i bind the value of an input in popup.html to a value to be used by functions in my content script

---

## Assistant

To bind the value of an input in popup.html to a value to be used by functions in your content script, you can use message passing between your popup and content script. Here's an example:

1. In popup.html, bind the value of the input to a variable when it changes:

```
<input id="inputValue" type="text">

<script>
  const input = document.getElementById("inputValue");
  input.addEventListener("change", function() {
    const value = input.value;
    chrome.runtime.sendMessage({ type: "inputValue", value });
  });
</script>
```

2. In your content script, listen for messages sent from the popup:

```
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.type === "inputValue") {
    const inputValue = request.value;
    // Use the inputValue in your content script
  }
});
```

Now, every time the value of the input changes, it will be sent to the content script via a message, and you can use the updated value in your content script.

---

## User


    <div class="flex">
        <input id="swipeRightCount" type="number" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Swipe right count">
        <input id="welcomeMessage" type="text" class="bg-indigo-500 px-4 py-2 rounded-md mx-auto hover:bg-indigo-600 text-white" placeholder="Welcome message">
    </div>

use these inputs and show me how to set their values in the js

here is the js

document.getElementById("extendAllMatches").addEventListener("click", function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "extendAllMatches" });
    });
});

document.getElementById("sendWelcomeMessage").addEventListener("click", function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "sendWelcomeMessage" });
    });
});

document.getElementById("swipeRight").addEventListener("click", function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "swipeRight" });
    });
});

document.getElementById("acceptAllMatches").addEventListener("click", function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "acceptAllMatches" });
    });
});

---

## Assistant

To set the values of the inputs in JavaScript, you can use the following code:

```
const swipeRightCount = document.getElementById("swipeRightCount");
const welcomeMessage = document.getElementById("welcomeMessage");

document.getElementById("sendWelcomeMessage").addEventListener("click", function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "sendWelcomeMessage", swipeRightCount: swipeRightCount.value, welcomeMessage: welcomeMessage.value });
    });
});
```

In this example, we retrieve the values of the `swipeRightCount` and `welcomeMessage` inputs using `document.getElementById()`, and then pass the values along with the message when the `sendWelcomeMessage` button is clicked. In the content script, you can access these values by receiving the message and accessing the `swipeRightCount` and `welcomeMessage` properties.


## See Also
- [[chatgpt/chatgpt_animation-script-expression]]
- [[chatgpt/chatgpt_branch-cinematic-demo-script]]
- [[chatgpt/chatgpt_brief-summary-script-request]]
- [[chatgpt/chatgpt_chrome-extension-popup-script]]
- [[chatgpt/chatgpt_cinematic-demo-script]]

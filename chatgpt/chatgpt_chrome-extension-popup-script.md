---
title: "Chrome Extension Popup Script"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: 8ca74665-6e8f-4cf6-a164-2571571388f8
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Chrome Extension Popup Script

> Conversation ID: 8ca74665-6e8f-4cf6-a164-2571571388f8
> Created: 2023-02-12T18:49:41Z
> Updated: 2023-02-12T18:49:41Z
> Messages: 6

---

## User

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
    // Get the initial values from chrome sync storage
    chrome.storage.sync.get(["totalSwipes", "delay"], function (result) {
      totalSwipesInput.value = result.totalSwipes || 7;
      delayInput.value = result.delay || 2000;

      // Use the retrieved values in your code
      chrome.tabs.sendMessage(tabs[0].id, { type: "swipeRight", numClicks: 10, delay: delay, totalSwipes: totalSwipes });
    });
  });
});

//add one for swipe10
document.getElementById("swipe10").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "swipeRight", numClicks: 10, delay: 200, totalSwipes: 100 });
  });
});

document.getElementById("acceptAllMatches").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "acceptAllMatches" });
  });
});


and this is in my content script


chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type === "extendAllMatches") {
    extendAllMatches();
  } else if (request.type === "sendWelcomeMessage") {
    sendWelcomeMessage();
  } else if (request.type === "swipeRight") {
    swipeRight(request.delay, request.totalSwipes);
  } else if (request.type === "acceptAllMatches") {
    acceptAllMatches();
  }
});

function extendAllMatches() {
  // Your implementation for extending all matches
  console.log("extending all matches");

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

  clickFirstProfile();
}

function sendWelcomeMessage(message) {
  // Your implementation for sending a welcome message
  console.log("sending welcome message");
  var textarea = document.querySelector(".textarea__input");
  textarea.value = message;

  var sendButton = document.querySelector(".message-field__send");
  sendButton.click();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function swipeRight(delay, totalSwipes, numClicks = 20) {
  console.log(`Starting swipeRight with delay of ${delay}ms and ${totalSwipes} swipes`);

  console.log(`totalSwipes: ${totalSwipes}`);

  var els = document.getElementsByClassName("encounters-controls__action");
  var clicks = 0;

  for (let z = 0; z < totalSwipes; z++) {
    console.log(`Iteration ${z} of ${totalSwipes}`);

    if (typeof els.length !== "undefined" && els.length >= 2) {
      console.log(`Found ${els.length} elements with class 'encounters-controls__action'`);

      loopi: for (var i = 0; i < els.length; i++) {
        console.log(`Checking element ${i} of ${els.length}`);

        if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
          console.log(`Found children for element ${i}`);

          loopj: for (var j = 0; j < els[i].children.length; j++) {
            console.log(`Checking child element ${j} of ${els[i].children.length}`);

            if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
              console.log(`Found classList for child element ${j}`);

              loopk: for (var k = 0; k < els[i].children[j].classList.length; k++) {
                console.log(`Checking classList index ${k} of ${els[i].children[j].classList.length}`);

                if (els[i].children[j].classList[k] == "encounters-action--like") {
                  console.log(`Found 'encounters-action--like' class at index ${k}`);
                  console.log("Clicking like");
                  eventFire(els[i].children[j], "click");
                  clicks++;
                  console.log(`Clicks: ${clicks}`);
                  if (clicks >= numClicks) {
                    console.log("Reached maximum number of clicks");
                    break loopi;
                  }
                  console.log(`Sleeping for ${delay}ms`);
                  await sleep(delay);
                }
              }
            }
          }
        }
      }
    }
  }
  console.log("Finished swipeRight");
}

var hwnd;
var tickRate = 1000;
var debugMode = false;
var isBumbling = false;

function eventFire(el, etype) {
  if (el.fireEvent) {
    el.fireEvent("on" + etype);
  } else {
    var evObj = document.createEvent("Events");
    evObj.initEvent(etype, true, false);
    el.dispatchEvent(evObj);
  }
}


when i click the swipright button it logs this
Starting swipeRight with delay of [object Object]ms and [object Object] swipes
contentScript.js:90 totalSwipes: [object Object]
contentScript.js:136 Finished swipeRight

---

## Assistant

This code creates a Chrome extension popup that interacts with a content script. The popup has several buttons that the user can click to perform various actions on the active tab, such as extending all matches, sending a welcome message, swiping right, and accepting all matches.

When the user clicks one of the buttons, the popup sends a message to the content script with the desired action. The content script listens for these messages using `chrome.runtime.onMessage.addListener` and performs the corresponding action by calling the appropriate function.

The code makes use of Chrome's storage API (`chrome.storage.sync`) to save and retrieve the values of the total number of swipes and delay between swipes. The values are used in the `swipeRight` function to determine how many swipes to perform and the delay between each swipe.

The `extendAllMatches`, `sendWelcomeMessage`, and `acceptAllMatches` functions perform the corresponding actions by clicking on specific elements on the page and manipulating the DOM. The `swipeRight` function performs a certain number of swipes with a specified delay between each swipe.

---

## User

why is the logging showing [object object] instead of the values

---

## Assistant

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

---

## User

can you modify the code so it gets the values from the object before sending the chrome message to the content script

---

## Assistant

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


## See Also
- [[chatgpt/chatgpt_chrome-extension-function-location]]
- [[chatgpt/chatgpt_chrome-extension-interaction]]
- [[chatgpt/chatgpt_chrome-extension-production-url]]
- [[chatgpt/chatgpt_chrome-extension-upload-error]]
- [[chatgpt/chatgpt_chrome-extension-webpack-config]]

---
title: "JS Swipe Right Function"
type: note
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: 338993d0-be56-4f61-a016-54929c985b2f
message_count: 4
tags: [chatgpt, import]
---
# JS Swipe Right Function

> Conversation ID: 338993d0-be56-4f61-a016-54929c985b2f
> Created: 2023-02-12T05:14:23Z
> Updated: 2023-02-12T05:14:23Z
> Messages: 4

---

## User


async function swipeRight(totalSwipes, delay = 1000, numClicks = 20) {
  console.log(`Starting swipeRight with delay of ${delay}ms and ${numClicks} clicks`);

  var els = document.getElementsByClassName("encounters-controls__action");
  var clicks = 0;
  console.log(`totalSwipes: ${totalSwipes}`);

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


---

## Assistant

This is a JavaScript function that performs a series of automated "swipe right" actions on a dating app. The function takes in three parameters: `totalSwipes`, `delay`, and `numClicks`.

The function uses the `document.getElementsByClassName` method to find elements with the class "encounters-controls__action". It then iterates through these elements and their child elements to find the element with the class "encounters-action--like". When this element is found, the function clicks on it using the `eventFire` function and increments a `clicks` counter. If the number of clicks reaches the value of `numClicks`, the function stops performing swipes. If the number of clicks is less than `numClicks`, the function waits for `delay` milliseconds before performing the next swipe.

The function uses the `await` keyword in front of the `sleep` function to pause execution for the specified `delay` milliseconds.

---

## User

thats in my content script and this is my popup.js

document.getElementById("swipeRight").addEventListener("click", function () {
  var numClicks = 10;
  var delay = 1000;
  var totalSwipes = 8;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, { type: "swipeRight", numClicks: numClicks, delay: delay, totalSwipes: totalSwipes });
  });
});

---

## Assistant

This is a JavaScript function that sets up a click event listener for an element with the id "swipeRight". When the element is clicked, the function retrieves the current active tab in the current window using the `chrome.tabs.query` method and sends a message to the content script of that tab using the `chrome.tabs.sendMessage` method. The message consists of an object with properties `type`, `numClicks`, `delay`, and `totalSwipes`. The values for `numClicks`, `delay`, and `totalSwipes` are set to `10`, `1000`, and `8`, respectively.

This code is part of a Chrome extension, as it uses the `chrome` API provided by the Chrome browser. The message sent to the content script is used to trigger the `swipeRight` function, which performs the automated "swipe right" actions.


## See Also
- [[chatgpt/chatgpt_js-function-swipe-right-2]]
- [[chatgpt/chatgpt_js-function-swipe-right]]
- [[chatgpt/chatgpt_swipe-right-function-analysis]]
- [[chatgpt/chatgpt_swipe-right-javascript-function]]
- [[chatgpt/chatgpt_automating-swipe-right-js]]

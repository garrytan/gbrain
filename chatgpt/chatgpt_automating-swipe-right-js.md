---
title: "Automating Swipe Right JS"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: 405a9b93-b7c1-420c-ad64-b0f66584abeb
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Automating Swipe Right JS

> Conversation ID: 405a9b93-b7c1-420c-ad64-b0f66584abeb
> Created: 2023-02-12T01:39:32Z
> Updated: 2023-02-12T01:39:32Z
> Messages: 8

---

## User

async function swipeRight() {
    var els = document.getElementsByClassName("encounters-controls__action");
    if (typeof els.length !== "undefined" && els.length >= 2) {
        loopi: for (var i = 0; i < els.length; i++) {
            if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
                loopj: for (var j = 0; j < els[i].children.length; j++) {
                    if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
                        loopk: for (var k = 0; k < els[i].children[j].classList.length; k++) {
                            if (els[i].children[j].classList[k] == "encounters-action--like") {
                                if (debugMode)
                                    console.log("Clicking like");
                                eventFire(els[i].children[j], "click");
                                break loopi;
                            }
                        }
                    }
                }
            }
        }
    }
}
var hwnd;
var tickRate = 1000;
var debugMode = false;
var isBumbling = false;

function eventFire(el, etype) {
    if (el.fireEvent) {
        el.fireEvent('on' + etype);
    } else {
        var evObj = document.createEvent('Events');
        evObj.initEvent(etype, true, false);
        el.dispatchEvent(evObj);
    }
}


---

## Assistant

This is JavaScript code that automates the process of swiping right on a dating app. It uses the DOM (Document Object Model) to select elements on the page, specifically the elements with the class name "encounters-controls__action".

The `swipeRight()` function first checks if the elements with the specified class name exist, and if so, it loops through each of them to look for the "encounters-action--like" class. If it finds the class, it uses the `eventFire()` function to simulate a click event on that element, which effectively simulates a "swipe right."

The `eventFire()` function is used to trigger the click event, and it works by either firing the "onclick" event if the `fireEvent` property is available, or by creating a new event using `document.createEvent()` and dispatching it using the `dispatchEvent()` method.

The rest of the code seems to define some global variables, such as `tickRate` and `debugMode`, which are used for controlling the rate of execution and turning on/off debug logs, respectively.

---

## User

modify the swiperight function to accept 2 values:
delay = a delay between clicks
numClicks = the number of times to click before stopping


---

## Assistant

Here's the modified code:

```
async function swipeRight(delay, numClicks) {
  var els = document.getElementsByClassName("encounters-controls__action");
  var clicks = 0;
  
  if (typeof els.length !== "undefined" && els.length >= 2) {
    loopi: for (var i = 0; i < els.length; i++) {
      if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
        loopj: for (var j = 0; j < els[i].children.length; j++) {
          if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
            loopk: for (var k = 0; k < els[i].children[j].classList.length; k++) {
              if (els[i].children[j].classList[k] == "encounters-action--like") {
                if (debugMode) console.log("Clicking like");
                eventFire(els[i].children[j], "click");
                clicks++;
                if (clicks >= numClicks) break loopi;
                await sleep(delay);
              }
            }
          }
        }
      }
    }
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

The `swipeRight()` function now takes two arguments: `delay` and `numClicks`. The `delay` argument is used to specify the time to wait between each click (in milliseconds), and the `numClicks` argument is used to specify the number of clicks to perform before stopping.

In the modified code, a counter `clicks` is introduced to keep track of the number of clicks performed. Every time a click is performed, the counter is incremented, and if it reaches the `numClicks` value, the loop is broken and the function terminates.

A new `sleep()` function is also added to the code, which accepts a delay value (in milliseconds) and returns a Promise that resolves after the specified delay. The `sleep()` function is used in the loop to wait for the specified delay between clicks.

---

## User


ok now we need a function to handle the match popup.

so if we detect encounters-match__content on the page
then we should click the data-qa-role="button" element

make this its own function

---

## Assistant

Here's the function to handle the match popup:

```
async function handleMatchPopup() {
  var matchContent = document.getElementsByClassName("encounters-match__content");
  if (typeof matchContent.length !== "undefined" && matchContent.length > 0) {
    var matchButton = matchContent[0].querySelector("[data-qa-role='button']");
    if (matchButton) {
      if (debugMode) console.log("Clicking match button");
      eventFire(matchButton, "click");
    }
  }
}
```

The `handleMatchPopup()` function checks if there is an element with the class `encounters-match__content` on the page. If such an element exists, it selects the first one and searches for a child element with the `data-qa-role` attribute set to "button". If such an element is found, it is clicked using the `eventFire()` function.

---

## User

async function swipeRight(delay, numClicks) {
    var els = document.getElementsByClassName("encounters-controls__action");
    var clicks = 0;

    if (typeof els.length !== "undefined" && els.length >= 2) {
        loopi: for (var i = 0; i < els.length; i++) {
            if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
                loopj: for (var j = 0; j < els[i].children.length; j++) {
                    if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
                        loopk: for (var k = 0; k < els[i].children[j].classList.length; k++) {
                            if (els[i].children[j].classList[k] == "encounters-action--like") {
                                if (debugMode) console.log("Clicking like");
                                eventFire(els[i].children[j], "click");
                                clicks++;
                                if (clicks >= numClicks) break loopi;
                                await sleep(delay);
                            }
                        }
                    }
                }
            }
        }
    }
}

now we need to call that function inside the swipe right function so that we can dismiss the popup.

we should modify the swipe right function so it

1 swipes right
2 triggers our new function to dismiss the popup if it exists
3 waits 2 seconds 
4 repeats the loop

the loop should repeat 3 times

---

## Assistant

Here's the updated `swipeRight()` function:

```
async function swipeRight(delay, numClicks) {
  var els = document.getElementsByClassName("encounters-controls__action");
  var clicks = 0;

  for (var loop = 0; loop < 3; loop++) {
    if (typeof els.length !== "undefined" && els.length >= 2) {
      loopi: for (var i = 0; i < els.length; i++) {
        if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
          loopj: for (var j = 0; j < els[i].children.length; j++) {
            if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
              loopk: for (var k = 0; k < els[i].children[j].classList.length; k++) {
                if (els[i].children[j].classList[k] == "encounters-action--like") {
                  if (debugMode) console.log("Clicking like");
                  eventFire(els[i].children[j], "click");
                  clicks++;
                  if (clicks >= numClicks) break loopi;
                  await sleep(delay);
                  handleMatchPopup();
                  await sleep(2000);
                }
              }
            }
          }
        }
      }
    }
  }
}
```

The function now performs the swiping right, dismissing the popup if it exists, waiting 2 seconds, and repeating the loop 3 times. After each "like" click, the function calls the `handleMatchPopup()` function to dismiss the popup if it exists, and then waits 2 seconds using `sleep(2000)`.

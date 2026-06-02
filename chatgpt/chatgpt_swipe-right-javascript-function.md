---
conversation_id: 6535e1b2-41d9-4d31-ab83-f2ffe5c81269
created: 2023-02-12
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Swipe Right JavaScript Function
type: note
updated: 2023-02-12
---

# Swipe Right JavaScript Function

**Related:** [[coding_web_dev]]

> Conversation ID: 6535e1b2-41d9-4d31-ab83-f2ffe5c81269
> Created: 2023-02-12T00:57:39Z
> Updated: 2023-02-12T00:57:39Z
> Messages: 4

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

---

## Assistant

This is a JavaScript function that automatically swipes right on a dating app. It uses the Document Object Model (DOM) to find elements with the class name "encounters-controls__action". The function then loops through these elements, and their children, to find the element with the class name "encounters-action--like". Finally, it simulates a click event on the "like" element using the `eventFire` function.

---

## User

We need to improve this function.

We should be able to set the number of times to swipe right.
If the value is 0 we should keep swiping right until we run out of results and then we should alert the user.

---

## Assistant

Here's an updated version of the function that implements the desired improvements:

```
async function swipeRight(numOfSwipes = 0) {
    var els = document.getElementsByClassName("encounters-controls__action");
    var count = 0;

    while (els.length >= 2 && (count < numOfSwipes || numOfSwipes === 0)) {
        for (var i = 0; i < els.length; i++) {
            if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
                for (var j = 0; j < els[i].children.length; j++) {
                    if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
                        for (var k = 0; k < els[i].children[j].classList.length; k++) {
                            if (els[i].children[j].classList[k] == "encounters-action--like") {
                                eventFire(els[i].children[j], "click");
                                count++;
                                break;
                            }
                        }
                    }
                }
            }
        }

        els = document.getElementsByClassName("encounters-controls__action");
    }

    if (count === 0) {
        alert("No more profiles to swipe right on.");
    }
}
```

The function now takes an optional parameter `numOfSwipes`, which specifies the number of times to swipe right. If `numOfSwipes` is 0, the function will keep swiping right until there are no more profiles to swipe on, at which point it will alert the user that there are no more profiles.


**Topic:** [[chatgpt-clusters/coding_web_dev]]

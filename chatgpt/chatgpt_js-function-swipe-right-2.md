---
title: "JS Function: Swipe Right"
type: note
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: e0de890e-91c6-467f-aad8-37a1927c8205
message_count: 4
tags: [chatgpt, import, code]
---
# JS Function: Swipe Right

> Conversation ID: e0de890e-91c6-467f-aad8-37a1927c8205
> Created: 2023-02-12T03:11:11Z
> Updated: 2023-02-12T03:11:11Z
> Messages: 4

---

## User

async function swipeRight(delay, numClicks) {
    console.log(`Starting swipeRight with delay of ${delay}ms and ${numClicks} clicks`);



    var els = document.getElementsByClassName("encounters-controls__action");
    var clicks = 0;

    if (typeof els.length !== "undefined" && els.length >= 2) {
        console.log(`Found ${els.length} elements with class 'encounters-controls__action'`);

        loopi: for (var i = 0; i < els.length; i++) {
            if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
                console.log(`Found children for element ${i}`);

                loopj: for (var j = 0; j < els[i].children.length; j++) {
                    if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
                        console.log(`Found classList for child element ${j}`);

                        loopk: for (var k = 0; k < els[i].children[j].classList.length; k++) {
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
    console.log("Finished swipeRight");
}

---

## Assistant

This JavaScript code defines an asynchronous function named "swipeRight" that takes two parameters, "delay" and "numClicks". The function logs a message indicating that it has started, and then it tries to find elements on a page with the class name "encounters-controls__action". If it finds elements with that class name, it loops through each of them and their children elements. Within the nested loops, it checks if any of the children elements have a class named "encounters-action--like". If it finds a class named "encounters-action--like", it clicks on it and increments the number of clicks by 1. If the number of clicks reaches the value of "numClicks", the function stops clicking and terminates. Finally, the function logs a message indicating that it has finished.

---

## User

this function successfully swipes right on a profile.

Now i need it to swipe right on 10 profiles.

---

## Assistant

You can modify the function to swipe right on 10 profiles by simply calling the function 10 times and incrementing the "numClicks" parameter each time. Here's an example:

```
async function swipeRightMultiple(delay, numClicks) {
  for (let i = 0; i < 10; i++) {
    await swipeRight(delay, numClicks);
    numClicks++;
  }
}
```

This function calls the "swipeRight" function 10 times in a loop, incrementing the "numClicks" parameter each time. This way, the function will swipe right on 10 profiles, each time incrementing the number of clicks by 1.

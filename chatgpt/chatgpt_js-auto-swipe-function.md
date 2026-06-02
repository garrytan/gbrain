---
title: "JS Auto Swipe Function"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: 82799ee6-698d-429f-802f-53e53a6dccfb
message_count: 4
tags: [chatgpt, import, code]
---
# JS Auto Swipe Function

> Conversation ID: 82799ee6-698d-429f-802f-53e53a6dccfb
> Created: 2023-02-12T06:00:42Z
> Updated: 2023-02-12T06:00:42Z
> Messages: 4

---

## User


async function swipeRight(totalSwipes = 20, delay = 1000, numClicks = 20) {
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

This is a JavaScript function that automates the process of swiping right on a dating app. The function takes in three parameters: `totalSwipes`, `delay`, and `numClicks`.

`totalSwipes` specifies the number of times the function will perform the swiping action. `delay` sets the time in milliseconds that the function will wait between each swipe. `numClicks` specifies the maximum number of swipes to perform.

The function uses JavaScript to find HTML elements with the class "encounters-controls__action" on the web page. It then loops through these elements, searching for a child element with the class "encounters-action--like". If found, the function uses the `eventFire` function to simulate a mouse click on the "like" button.

Finally, the function uses `await sleep(delay)` to wait for `delay` milliseconds before continuing to the next swipe. The function logs the progress of the swiping process in the console.

---

## User

instead of the totalswipes value use the variable swipeRightCount if it exists otherwise use 10

---

## Assistant

You can modify the function like this:

```
async function swipeRight(delay = 1000, numClicks = 20) {
  console.log(`Starting swipeRight with delay of ${delay}ms and ${numClicks} clicks`);

  var totalSwipes = swipeRightCount || 10;
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
```

Now, if `swipeRightCount` exists, it will be used as the value for `totalSwipes`, otherwise `totalSwipes` will be set to 10.


## See Also
- [[chatgpt/chatgpt_js-function-swipe-right-2]]
- [[chatgpt/chatgpt_js-function-swipe-right]]
- [[chatgpt/chatgpt_js-swipe-right-function]]
- [[chatgpt/chatgpt_swipe-right-function-analysis]]
- [[chatgpt/chatgpt_swipe-right-javascript-function]]

---
title: "New chat"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
conversation_id: dca98399-0b9b-4269-9226-af3ef183b91e
message_count: 8
tags: [chatgpt, import, code]
---
# New chat

> Conversation ID: dca98399-0b9b-4269-9226-af3ef183b91e
> Created: 2023-02-12T04:58:27Z
> Updated: 2023-02-12T04:58:27Z
> Messages: 8

---

## User


async function swipeRight(delay = 1000, numClicks = 20) {
  console.log(`Starting swipeRight with delay of ${delay}ms and ${numClicks} clicks`);

  var els = document.getElementsByClassName("encounters-controls__action");
  var clicks = 0;
  var totalSwipes = 10;
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

This code implements an async function `swipeRight` which performs an automatic swipe right action on a dating website. The function takes two parameters: `delay` and `numClicks`, both with default values of 1000 milliseconds and 20 clicks, respectively. The purpose of the function is to find elements on a webpage with the class `encounters-controls__action`, then find the child elements with the class `encounters-action--like` and simulate a click on these elements. The function performs this action `numClicks` number of times with a delay of `delay` milliseconds between each click. The code uses a series of nested for loops to find the desired elements and simulate the clicks. The `sleep` function is used to pause the execution of the code for a specified amount of time. The `eventFire` function is used to simulate a click event on a specified element.

---

## User

lets accept total swipes as a value passed into the function

---

## Assistant

Sure, we can modify the function to accept the `totalSwipes` as an argument passed into the function. Here's the updated code:

```
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
```

---

## User

document.getElementById("swipeRight").addEventListener("click", function() {
    var numClicks = 10;
    var delay = 1000;
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "swipeRight", numClicks: 10, delay: 200 });
    });
});

we need to add the totalswipes here as well

---

## Assistant

Sure, you can add the `totalSwipes` parameter to the function that's called when the "swipeRight" button is clicked. Here's an updated version:

```
document.getElementById("swipeRight").addEventListener("click", function() {
    var numClicks = 10;
    var delay = 1000;
    var totalSwipes = 5;
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "swipeRight", numClicks: numClicks, delay: delay, totalSwipes: totalSwipes });
    });
});
```

You can adjust the values of `numClicks`, `delay`, and `totalSwipes` to your desired values.

---

## User

this does not seem to be working to pass the values

---

## Assistant

The code you posted seems to be missing the `async` function definition, but the message sending part seems correct. Here's an updated version of the entire code:

```
async function swipeRight(delay = 1000, numClicks = 20, totalSwipes = 5) {
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
                console.log(`Checking classList

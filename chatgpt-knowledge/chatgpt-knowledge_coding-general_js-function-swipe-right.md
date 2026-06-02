---
title: "JS Function: Swipe Right"
type: guide
created: 2023-02-12
updated: 2023-02-12
source: chatgpt-export
topic: coding-general
message_count: 15
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# JS Function: Swipe Right

> **Source:** ChatGPT conversation
> **Date:** 2023-02-12T03:36:27Z
> **Messages:** 15
> **Topic:** coding-general

## Question


async function swipeRight(delay, numClicks) {
    console.log(`Starting swipeRight with delay of ${delay}ms and ${numClicks} clicks`);



    var els = document.getElementsByClassName("encounters-controls__action");
    var clicks = 0;
    var totalSwipes = 10;
    for (let z = 0; z < totalSwipes; z++) {
        if (typeof els.length !== "undefined" && els.length >= 2) {
            console.log(`Found ${els.length} elements with class 'encounters-controls__action'`);

            loopi: for (var i = 0; i < els.length; i++) {
                if (typeof els[i].children !== "undefined" && els[i].children.length > 0) {
                    console.log(`Found children for element ${i}`);

                    loopj: for (var j = 0; j < els[i].children.length; j++) {
                        if (typeof els[i].children[j].classList !== "undefined" && typeof els[i].children[j].classList.length !== "undefined" && els[i].children[j].classList.length > 0) {
                            console.log(`

## Answer

This is a JavaScript function that automates swiping right on a dating app. The function takes two arguments: `delay` and `numClicks`. The `delay` argument specifies the time in milliseconds that the function should wait before clicking the next like button. The `numClicks` argument specifies the maximum number of times the function should click the like button.

The function uses the `getElementsByClassName` method to find elements on the page with the class name "encounters-controls__action". The function then loops through these elements and their children to find the element with the class "encounters-action--like", which represents the like button. When this element is found, the function calls the `eventFire` function and passes the like button element and the string "click" as arguments. This simulates a mouse click on the like button. The function increments the `clicks` variable after each click and checks if `clicks` is greater than or equal to `numClicks`. If it is, the function breaks out of the loop and logs "Reached maximum number of clicks". If not, the function waits for `delay` milliseconds before clicking the next like button. The function continues to loop through the elements and their children until all the elements have been processed or the maximum number of clicks has been reached.

The function logs various messages to the console throughout its execution to help with debugging and to provide feedback on its progress.

## Question

when i click the button it swipes right once and then stops

## Answer

It seems like the function is only processing one iteration of the loop, which results in only one swipe. To fix this, you need to make sure that the loop is running the correct number of times.

You can check the value of the `totalSwipes` variable to make sure it's set to the correct value. Also, make sure that the `break loopi` statement is not being triggered prematurely, as this would cause the loop to exit before the desired number of swipes have been completed.

It's also possible that the issue is related to the DOM elements and their properties. Make sure that the elements are being found correctly and that the children and class lists of the elements have the expected structure. You can use the logs in the function to debug this issue.

## Question

add logs needed to debug this

## Answer

Here's an updated version of the function with additional logs to help debug the issue:

```
async function swipeRight(delay, numClicks) {
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
```

With these additional logs, you should be able to see which part of the code is causing the issue and why the function is only swiping right once.

## Answer

To help debug the issue, you can add the following logs to the function:

```
async function swipeRight(delay, numClicks) {

## Question

contentScript.js:18 fr
contentScript.js:19 null
contentScript.js:20 null
contentScript.js:95 Starting swipeRight with delay of undefinedms and undefined clicks
contentScript.js:100 totalSwipes: 10
contentScript.js:103 Iteration 0 of 10
contentScript.js:106 Found 3 elements with class 'encounters-controls__action'
contentScript.js:109 Checking element 0 of 3
contentScript.js:112 Found children for element 0
contentScript.js:115 Checking child element 0 of 1
contentScript.js:118 Found classList for child element 0
contentScript.js:121 Checking classList index 0 of 3
contentScript.js:121 Checking classList index 1 of 3
contentScript.js:121 Checking classList index 2 of 3
contentScript.js:109 Checking element 1 of 3
contentScript.js:112 Found children for element 1
contentScript.js:115 Checking child element 0 of 1
contentScript.js:118 Found classList for child element 0
contentScript.js:121 Checking classList index 0 of 4
contentScript.js:121 Checking classList index 1 of 4
contentScript.

## Answer

It looks like you have some code that is trying to simulate swiping right and clicking on an element with the class "encounters-action--like". 

To debug this code, you could add log statements to see what elements the code is interacting with, at each step of the process. For example:

1. Log the elements that are being selected by the code. 

```
console.log("Elements selected: ", elements);
```

2. Log whether the code is successfully finding the "encounters-action--like" class. 

```
console.log("Like class found: ", hasLikeClass);
```

3. Log the delay that is being used before clicking the element. 

```
console.log("Delay before click: ", delay);
```

4. Log the number of clicks that have occurred. 

```
console.log("Clicks: ", clicks);
```

By adding these log statements, you can see exactly what the code is doing at each step and identify any issues that may be causing it to not work as intended.

## Question

it seems the loop is processing all 10 iterations in under a second

## Answer

Yes, that is correct based on the information you have provided. It's possible that the delay of "undefinedms" is causing the loop to process all 10 iterations very quickly, which may result in unexpected behavior. You may want to consider adding a delay or updating the delay value to be a specific amount of time.

## Question

we need to pause. can we set a default delay of 1 second between iterations

## Answer

Yes, you can add a delay of 1 second between each iteration by using the `sleep` function from the `time` module in Python.

Here's an example:

```
import time

for i in range(10):
    print(i)
    time.sleep(1)
```

This code will print the current iteration number and then wait for 1 second before moving on to the next iteration.

## Question

great add this to the function:


async function swipeRight(delay, numClicks) {
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
                   

## Answer

Sure, here's the updated code with a default delay of 1000ms (1 second) between iterations:

```
async function swipeRight(delay = 1000, numClicks) {
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
```

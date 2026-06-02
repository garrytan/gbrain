---
title: "JS Bumble Connections Automation"
type: guide
created: 2023-02-11
updated: 2023-02-11
source: chatgpt-export
conversation_id: 0e9729f4-953f-42d9-a87f-c13a10dc03d4
message_count: 6
tags: [chatgpt, import, code]
---
# JS Bumble Connections Automation

> Conversation ID: 0e9729f4-953f-42d9-a87f-c13a10dc03d4
> Created: 2023-02-11T00:20:48Z
> Updated: 2023-02-11T00:20:48Z
> Messages: 6

---

## User

 //get scrollable-carousel__scroll and go to each item
                        carousel = document.getElementsByClassName("scrollable-carousel__scroll");
                        console.log("the carousel is " + carousel);
                        for (var i = 0; i < carousel.length; i++) {
                            console.log("the carousel item is " + carousel[i]);
                            carousel[i].click();

                            //log checking if match needs extending
                            console.log("checking if match needs extending");


                            if (window.location.href == "https://bumble.com/app/connections") {
                                console.log("this is the connections page");
                                var bumble_time = document.evaluate("//b", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue.innerText;
                                console.log("the bumble time is " + bumble_time);
                                var bumble_time = bumble_time.replace(/[^0-9]/g, '');
                                console.log("the bumble time is " + bumble_time);
                                if (bumble_time < 4) {

                                    console.log("the bumble time is less than 4");
                                    var bumble_button = document.evaluate("//button", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue;
                                    bumble_button.click();
                                    setTimeout(function() {
                                        console.log("clicked the bumble button");
                                    }, 1000);
                                }
                            }


---

## Assistant

This is JavaScript code that appears to automate certain actions on the Bumble dating app website. The code first gets an element with the class name "scrollable-carousel__scroll" and logs it to the console. Then it loops through each item in the carousel and clicks on it.

Next, the code checks if the URL of the current page is "https://bumble.com/app/connections" and if so, it logs "this is the connections page". It then evaluates the first element with the tag name "b" and gets its inner text, which it logs to the console.

The inner text is then processed to only keep the digits and logged again. If the resulting value is less than 4, the code evaluates the first button element on the page and clicks it. After clicking the button, it logs "clicked the bumble button" after a 1-second delay.

---

## User

Are there any issues?


---

## Assistant

There are a few potential issues with this code:

1. Error handling: There's no error handling in the code to handle cases where elements are not found, which could result in errors and stop the code from executing.

2. Use of innerText: The use of `innerText` to get the text content of an element is not recommended, as it's not supported by all browsers and can have compatibility issues. A more recommended approach would be to use `textContent`.

3. Use of setTimeout: The use of `setTimeout` function to wait for 1 second before logging "clicked the bumble button" may not be reliable as the timing of the action could be affected by various factors, such as the performance of the computer or network speed.

4. Use of XPath: The use of XPath to find elements on the page is not a recommended approach, as it can be slow and may not work in all browsers. A more recommended approach would be to use a CSS selector, such as `querySelector`.

5. Automation: Automating actions on a website can be against the terms of service of the website, and the actions performed by the code could have unintended consequences. It's always best to read the terms of service of a website before automating actions on it.

---

## User

we dont car about 5 or 4. show an example with the rest

---

## Assistant

Here's an updated version of the code that addresses the first two potential issues:

```
var carousel = document.getElementsByClassName("scrollable-carousel__scroll");
console.log("the carousel is ", carousel);
if (carousel.length > 0) {
  for (var i = 0; i < carousel.length; i++) {
    console.log("the carousel item is ", carousel[i]);
    carousel[i].click();

    console.log("checking if match needs extending");

    if (window.location.href === "https://bumble.com/app/connections") {
      console.log("this is the connections page");
      var bumbleTime = document.evaluate("//b", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue;
      if (bumbleTime) {
        bumbleTime = bumbleTime.textContent.replace(/[^0-9]/g, '');
        console.log("the bumble time is ", bumbleTime);
        if (parseInt(bumbleTime) < 4) {
          console.log("the bumble time is less than 4");
          var bumbleButton = document.evaluate("//button", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue;
          if (bumbleButton) {
            bumbleButton.click();
            console.log("clicked the bumble button");
          }
        }
      }
    }
  }
}
```

This code includes error handling for cases where the carousel elements and the elements found using XPath are not found on the page. It also uses `textContent` instead of `innerText` to get the text content of elements, and the text content is cast to an integer before being compared to 4.

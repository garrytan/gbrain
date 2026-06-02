---
title: "Automate follow clicks."
type: guide
created: 2024-05-29
updated: 2024-05-29
source: chatgpt-export
conversation_id: f5366c64-8157-4b91-ade6-764240cc91cb
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Automate follow clicks.

> Conversation ID: f5366c64-8157-4b91-ade6-764240cc91cb
> Created: 2024-05-29T21:02:03Z
> Updated: 2024-05-29T21:11:31Z
> Messages: 10

---

## User

javascript:(function(){function scrollAndClick(){var modal=document.querySelector('.Modal-module_body__efFIt .scrollbar-container');if(!modal){console.log('Modal element not found');return;}var scrollCount=0;var maxScrolls=5;function clickFollowButtons(){const buttons=document.querySelectorAll('.harmony-7dahz9');let delay=100;buttons.forEach((button,index)=>{setTimeout(()=>{button.click();},delay*index);});}function performScrollAndClick(){if(scrollCount>=maxScrolls){clickFollowButtons();scrollCount=0;}else{modal.scrollBy(0,100);scrollCount++;}var delay=Math.random()*(1500-500)+500;setTimeout(performScrollAndClick,delay);}clickFollowButtons();performScrollAndClick();}scrollAndClick();})();

---

## Assistant

This JavaScript code is designed to automate the process of scrolling through a modal and clicking on "Follow" buttons within a webpage. Here's a step-by-step explanation of what this code does:

1. **Initialization Function**: The `scrollAndClick` function is defined to encapsulate the entire process.
   
2. **Selecting Modal**: It tries to find a modal element with the class `Modal-module_body__efFIt` and an inner element with the class `scrollbar-container`.

3. **Error Handling**: If the modal element is not found, it logs a message to the console and stops execution.

4. **Scroll Variables**: It sets up variables to keep track of the number of scrolls (`scrollCount`) and the maximum number of scrolls (`maxScrolls`).

5. **Click Follow Buttons Function**: The `clickFollowButtons` function finds all elements with the class `harmony-7dahz9` (presumably the "Follow" buttons) and clicks each one with a delay of 100 milliseconds between clicks.

6. **Scrolling and Clicking Logic**: The `performScrollAndClick` function handles the logic for scrolling the modal and clicking the buttons.
   - If the number of scrolls (`scrollCount`) reaches the maximum (`maxScrolls`), it clicks the "Follow" buttons and resets the scroll count.
   - Otherwise, it scrolls the modal down by 100 pixels and increments the scroll count.
   - A delay between 500 and 1500 milliseconds (randomly chosen) is set before calling `performScrollAndClick` again, creating a loop.

7. **Initial Function Calls**: The `clickFollowButtons` function is called to ensure any visible "Follow" buttons are clicked before starting the scroll and click process. Then, `performScrollAndClick` is called to start the loop.

### Usage

To use this script, you can paste it into the console of a browser's developer tools while on the relevant webpage where the modal and buttons are present. It will automate the process of scrolling and clicking the follow buttons.

### Example Usage

1. Open the webpage where you want to automate the follow clicks.
2. Open Developer Tools (usually by pressing `F12` or `Ctrl+Shift+I`).
3. Navigate to the "Console" tab.
4. Paste the entire JavaScript code into the console and press `Enter`.

The script should start working immediately, scrolling through the modal and clicking the "Follow" buttons as it encounters them.

---

## User

its not very effecient currently. it works perfectly but its slow.

---

## Assistant

To make the script more efficient, we can optimize the scrolling and clicking process to reduce unnecessary delays and increase the speed of execution. Here's an improved version of the script:

```javascript
(function() {
    function scrollAndClick() {
        var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');
        if (!modal) {
            console.log('Modal element not found');
            return;
        }

        var scrollCount = 0;
        var maxScrolls = 5;

        function clickFollowButtons() {
            const buttons = document.querySelectorAll('.harmony-7dahz9');
            buttons.forEach((button) => {
                if (button.textContent.trim().toLowerCase() === 'follow') {
                    button.click();
                }
            });
        }

        function performScrollAndClick() {
            if (scrollCount >= maxScrolls) {
                clickFollowButtons();
                scrollCount = 0;
            } else {
                modal.scrollBy(0, 200); // Increase scroll amount to reduce the number of scrolls needed
                scrollCount++;
            }

            var delay = 300; // Reduce delay to speed up the process
            setTimeout(performScrollAndClick, delay);
        }

        performScrollAndClick();
    }

    scrollAndClick();
})();
```

### Changes Made:

1. **Increased Scroll Amount**: Changed `modal.scrollBy(0, 100)` to `modal.scrollBy(0, 200)` to reduce the number of scrolls needed.
2. **Reduced Delay**: Changed the delay between scrolls and clicks from a random value between 500 and 1500 milliseconds to a fixed 300 milliseconds. This will speed up the process considerably.
3. **Conditional Clicks**: Added a condition to check if the button text is "follow" (case-insensitive) before clicking, ensuring that only "Follow" buttons are clicked.

### Usage

Follow the same steps to use this script as before:

1. Open the webpage where you want to automate the follow clicks.
2. Open Developer Tools (usually by pressing `F12` or `Ctrl+Shift+I`).
3. Navigate to the "Console" tab.
4. Paste the entire JavaScript code into the console and press `Enter`.

This script should now work more efficiently, reducing the time it takes to scroll through the modal and click all the "Follow" buttons.

---

## User

now put it in one line i can use as a bookmark

---

## Assistant

Here's the improved script condensed into a single line for use as a bookmarklet:

```javascript
javascript:(function(){function scrollAndClick(){var modal=document.querySelector('.Modal-module_body__efFIt .scrollbar-container');if(!modal){console.log('Modal element not found');return;}var scrollCount=0;var maxScrolls=5;function clickFollowButtons(){const buttons=document.querySelectorAll('.harmony-7dahz9');buttons.forEach((button)=>{if(button.textContent.trim().toLowerCase()==='follow'){button.click();}});}function performScrollAndClick(){if(scrollCount>=maxScrolls){clickFollowButtons();scrollCount=0;}else{modal.scrollBy(0,200);scrollCount++;}var delay=300;setTimeout(performScrollAndClick,delay);}performScrollAndClick();}scrollAndClick();})();
```

You can create a bookmark and set its URL to the above code. When you click this bookmark while on the relevant webpage, it will execute the script and start the automated process.

---

## User

this is better. 

the issue now is the modal only loads so many results then we have to scroll. but the infinite scroll slows down the more results we have loaded and the memory chrome is using balloons til it starts to lock up.



---

## Assistant

To address the issue of the modal slowing down due to excessive memory usage from infinite scrolling, we can implement a more efficient approach by periodically clearing the modal's content to free up memory. This should help keep the browser from locking up. Here's an updated version of the script, optimized for better performance and memory management:

```javascript
javascript:(function(){function scrollAndClick(){var modal=document.querySelector('.Modal-module_body__efFIt .scrollbar-container');if(!modal){console.log('Modal element not found');return;}var scrollCount=0;var maxScrolls=5;var clearInterval=20;function clickFollowButtons(){const buttons=document.querySelectorAll('.harmony-7dahz9');buttons.forEach((button)=>{if(button.textContent.trim().toLowerCase()==='follow'){button.click();}});}function performScrollAndClick(){if(scrollCount>=maxScrolls){clickFollowButtons();scrollCount=0;}else{modal.scrollBy(0,200);scrollCount++;}if(scrollCount%clearInterval===0){modal.innerHTML='';}var delay=300;setTimeout(performScrollAndClick,delay);}performScrollAndClick();}scrollAndClick();})();
```

### Explanation:
1. **Clear Interval**: Introduced a `clearInterval` variable to determine how often the modal's content should be cleared (every 20 scrolls in this example).
2. **Clear Modal Content**: Added a condition to clear the modal's content (`modal.innerHTML=''`) every `clearInterval` scrolls to free up memory and reduce browser lag.

### Usage
Follow the same steps to use this script as before:

1. Open the webpage where you want to automate the follow clicks.
2. Open Developer Tools (usually by pressing `F12` or `Ctrl+Shift+I`).
3. Navigate to the "Console" tab.
4. Paste the entire JavaScript code into the console and press `Enter`.

This updated script should manage memory better by periodically clearing the modal's content, helping to prevent the browser from locking up due to excessive memory usage.

---

## User

that deleted the whole modal minus the header, not just the results

---

## Assistant

To ensure we only clear the content of the results within the modal, we need to target the specific container holding those results instead of clearing the entire modal. Here's the updated script:

```javascript
javascript:(function(){function scrollAndClick(){var modal=document.querySelector('.Modal-module_body__efFIt .scrollbar-container');if(!modal){console.log('Modal element not found');return;}var scrollCount=0;var maxScrolls=5;var clearInterval=20;function clickFollowButtons(){const buttons=document.querySelectorAll('.harmony-7dahz9');buttons.forEach((button)=>{if(button.textContent.trim().toLowerCase()==='follow'){button.click();}});}function performScrollAndClick(){if(scrollCount>=maxScrolls){clickFollowButtons();scrollCount=0;}else{modal.scrollBy(0,200);scrollCount++;}if(scrollCount%clearInterval===0){var resultsContainer=modal.querySelector('.results-container');if(resultsContainer){resultsContainer.innerHTML='';}}var delay=300;setTimeout(performScrollAndClick,delay);}performScrollAndClick();}scrollAndClick();})();
```

### Explanation:
1. **Target Results Container**: Added a line to select a hypothetical `results-container` inside the modal. Adjust the selector `.results-container` to match the actual class or id of the container that holds the results within the modal.
2. **Clear Results Only**: Clears only the results container's content every `clearInterval` scrolls, leaving the rest of the modal intact.

### Usage
Follow the same steps as before to use this script:

1. Open the webpage where you want to automate the follow clicks.
2. Open Developer Tools (usually by pressing `F12` or `Ctrl+Shift+I`).
3. Navigate to the "Console" tab.
4. Paste the entire JavaScript code into the console and press `Enter`.

Ensure that the selector `.results-container` accurately reflects the actual structure of the modal's DOM. You may need to inspect the modal's HTML structure to find the correct class or id for the results container.


## See Also
- [[chatgpt/chatgpt_automate-visual-profile-follow-part1]]
- [[chatgpt/chatgpt_automate-visual-profile-follow-part2]]
- [[chatgpt/chatgpt_automate-visual-profile-follow-part3]]
- [[chatgpt/chatgpt_automate-contact-poster-rotation]]
- [[chatgpt/chatgpt_automate-lint-typecheck]]

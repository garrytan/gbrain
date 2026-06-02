---
title: "Click Buttons with Delay"
type: essay
created: 2024-05-23
updated: 2024-05-23
source: chatgpt-export
conversation_id: 9cad3e68-676a-4012-a447-7716858fcf02
message_count: 24
tags: [chatgpt, import, code, long-form]
---
# Click Buttons with Delay

> Conversation ID: 9cad3e68-676a-4012-a447-7716858fcf02
> Created: 2024-05-23T21:57:01Z
> Updated: 2024-05-23T22:13:33Z
> Messages: 24


write a script i can paste in inspector to click all buttons with class
_user_11o7n_1 _notLastUser_11o7n_14

add a 100ms delay


Here's a script you can paste into the browser console to click all buttons with the specified classes, adding a 100ms delay between each click:

```javascript
const buttons = document.querySelectorAll('._user_11o7n_1._notLastUser_11o7n_14');
let delay = 100;

buttons.forEach((button, index) => {
  setTimeout(() => {
    button.click();
  }, delay * index);
});
```

This script selects all buttons with the classes `_user_11o7n_1` and `_notLastUser_11o7n_14`, and clicks them with a 100ms delay between each click.


actually should click all harmony-7dahz9


Here is the updated script to click all elements with the class `harmony-7dahz9` with a 100ms delay between each click:

```javascript
const buttons = document.querySelectorAll('.harmony-7dahz9');
let delay = 100;

buttons.forEach((button, index) => {
  setTimeout(() => {
    button.click();
  }, delay * index);
});
```

This script selects all elements with the class `harmony-7dahz9` and clicks them with a 100ms delay between each click.


should then scroll and then repeat


Here's an updated script that will click all elements with the class `harmony-7dahz9`, scroll down, and then repeat the process. This will continue until no more elements with the specified class are found:

```javascript
function clickButtonsAndScroll() {
  const buttons = document.querySelectorAll('.harmony-7dahz9');
  let delay = 100;

  if (buttons.length === 0) {
    console.log('No more buttons to click.');
    return;
  }

  buttons.forEach((button, index) => {
    setTimeout(() => {
      button.click();
    }, delay * index);
  });

  // Wait for all clicks to complete before scrolling and repeating
  setTimeout(() => {
    window.scrollBy(0, window.innerHeight);
    setTimeout(clickButtonsAndScroll, 2000); // Wait 2 seconds before repeating
  }, delay * buttons.length);
}

clickButtonsAndScroll();
```

This script will:
1. Click all elements with the class `harmony-7dahz9` with a 100ms delay between each click.
2. Scroll down by one viewport height.
3. Wait 2 seconds and repeat the process until no more elements with the specified class are found.


## See Also
- [[chatgpt/chatgpt_click-buttons-with-delay-part2]]
- [[chatgpt/chatgpt_click-buttons-with-delay-part3]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part1]]
- [[chatgpt/chatgpt_click-all-buttons-script]]
- [[chatgpt/chatgpt_click-all-follow-buttons]]

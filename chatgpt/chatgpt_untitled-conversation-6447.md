---
title: "Untitled Conversation 6447"
type: note
created: 2022-12-13
updated: 2022-12-13
source: chatgpt-export
conversation_id: b5d70cbd-e608-4aa8-b291-bb859518044c
message_count: 4
tags: [chatgpt, import, code]
---
# Untitled Conversation 6447

> Conversation ID: b5d70cbd-e608-4aa8-b291-bb859518044c
> Created: 2022-12-13T19:53:53Z
> Updated: 2022-12-13T19:53:53Z
> Messages: 4

---

## User

how can i loop through all the a links on a page and put their inner text in an array

---

## Assistant

Here's an example of how you could loop through all of the `a` elements on a page and add their inner text to an array:

```
const links = document.querySelectorAll('a');
const linkTexts = [];

for (let i = 0; i < links.length; i++) {
  linkTexts.push(links[i].innerText);
}
```

This code uses the `querySelectorAll` method to get a list of all `a` elements on the page. It then loops through the list of elements and adds the inner text of each element to an array called `linkTexts`.

You can then use the `linkTexts` array to do whatever you need to do with the text of the links on the page. For example, you could log the array to the console to see what it contains:

```
console.log(linkTexts);
```

Or you could use the array to perform some other action on the page, such as highlighting the links or changing their colors.



---

## User

can i first wait to make sure all the element on the page are loaded

---

## Assistant

Yes, you can use the `document.readyState` property to check whether the page has finished loading before running your code that loops through the links on the page.

Here's an example of how you could do this:

```
if (document.readyState === 'complete') {
  // Code to loop through links goes here
}
```

This code checks the value of the `readyState` property. If the value is `complete`, it means that the page has finished loading and all of the elements on the page are available. You can then run your code to loop through the links and add their inner text to an array.

Alternatively, you can use the `DOMContentLoaded` event to run your code as soon as the page has finished loading. Here's an example of how you could do this:

```
document.addEventListener('DOMContentLoaded', function() {
  // Code to loop through links goes here
});
```

This code adds an event listener for the `DOMContentLoaded` event. When this event is triggered, it means that the page has finished loading and all of the elements on the page are available. You can then run your code to loop through the links and add their inner text to an array.

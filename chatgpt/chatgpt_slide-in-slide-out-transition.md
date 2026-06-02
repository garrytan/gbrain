---
title: "Slide-in Slide-out Transition."
type: note
created: 2023-06-02
updated: 2023-06-02
source: chatgpt-export
conversation_id: 6e24de66-ee1b-4c19-b783-c8fb03fd4cf2
message_count: 2
tags: [chatgpt, import, code]
---
# Slide-in Slide-out Transition.

> Conversation ID: 6e24de66-ee1b-4c19-b783-c8fb03fd4cf2
> Created: 2023-06-02T19:51:27Z
> Updated: 2023-06-02T19:51:39Z
> Messages: 2

---

## User

   <TransitionRoot
                :show="searchVisible"
                enter="transition-opacity duration-75"
                enter-from="opacity-0"
                enter-to="opacity-100"
                leave="transition-opacity duration-0"
                leave-from="opacity-100"
                leave-to="opacity-0">

can we edit this so the item slides in from the right and out to the right

---

## Assistant

Certainly! To make the item slide in from the right and out to the right, you can modify the transition classes and add some additional styles. Here's an updated version of the code:

```html
<TransitionRoot
  :show="searchVisible"
  enter="transition-all duration-500"
  enter-from="transform translate-x-full"
  enter-to="transform translate-x-0"
  leave="transition-all duration-500"
  leave-from="transform translate-x-0"
  leave-to="transform translate-x-full"
>
```

In this updated code, we're using the `transition-all` class instead of `transition-opacity` to apply the transition effect to all CSS properties. The `duration-500` class sets the duration of the transition to 500 milliseconds. 

For the enter animation, we're using `transform translate-x-full` for the `enter-from` property to move the item offscreen to the right. Then, `transform translate-x-0` is used for the `enter-to` property to bring the item back to its original position, making it slide in from the right.

Similarly, for the leave animation, we're using `transform translate-x-0` for the `leave-from` property to keep the item in its current position. Then, `transform translate-x-full` is used for the `leave-to` property to move the item offscreen to the right, making it slide out to the right.

Feel free to adjust the duration or add additional classes/styles as needed to achieve the desired animation effect.

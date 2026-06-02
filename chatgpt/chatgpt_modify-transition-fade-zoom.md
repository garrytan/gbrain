---
title: "Modify Transition Fade Zoom"
type: note
created: 2022-12-21
updated: 2022-12-21
source: chatgpt-export
conversation_id: 54b12cd1-1f68-4fc3-b56d-6d4fb79c8fbe
message_count: 4
tags: [chatgpt, import, code]
---
# Modify Transition Fade Zoom

> Conversation ID: 54b12cd1-1f68-4fc3-b56d-6d4fb79c8fbe
> Created: 2022-12-21T07:14:36Z
> Updated: 2022-12-21T07:14:36Z
> Messages: 4

---

## User

change this transition to be a fade in and zoom out 

 <TransitionRoot
            appear
            :show="isShowing"
            as="template"
            enter="transform transition duration-[400ms]"
            enter-from="opacity-0 rotate-[-120deg] scale-50"
            enter-to="opacity-100 rotate-0 scale-100"
            leave="transform duration-200 transition ease-in-out"
            leave-from="opacity-100 rotate-0 scale-100 "
            leave-to="opacity-0 scale-95 ">
            <JovieLogo
              :color="darkMode ? '#ffffff' : '#000000'"
              height="48px" />
          </TransitionRoot>

---

## Assistant

To make this transition a fade in and zoom out, you can modify the `enter-from` and `enter-to` properties as follows:

```
enter-from="opacity-0 scale-50"
enter-to="opacity-100 scale-100"
```

This will cause the element to fade in and zoom out from 50% of its original size to its full size during the transition. You can also adjust the duration of the transition by modifying the `duration` property.

It's also worth noting that the `leave` properties are not relevant in this case, since they specify the animation for when the element is being removed from the DOM. If you want to specify an animation for when the element is hidden, you can add a `hide` property. For example:

```
hide="opacity-0"
```

This will cause the element to fade out when it is hidden.


---

## User

show me the full code

---

## Assistant

Here is the full code with the suggested modifications:

```
<TransitionRoot
  appear
  :show="isShowing"
  as="template"
  enter="transform transition duration-[400ms]"
  enter-from="opacity-0 scale-50"
  enter-to="opacity-100 scale-100"
  leave="transform duration-200 transition ease-in-out"
  leave-from="opacity-100 rotate-0 scale-100 "
  leave-to="opacity-0 scale-95 "
  hide="opacity-0"
>
  <JovieLogo
    :color="darkMode ? '#ffffff' : '#000000'"
    height="48px" 
  />
</TransitionRoot>
```

This code will cause the element to fade in and zoom out when it is added to the DOM, and fade out when it is hidden. The element will also rotate and scale out when it is removed from the DOM.


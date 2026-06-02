---
title: "HTML tabindex Attribute"
type: note
created: 2023-05-04
updated: 2023-05-04
source: chatgpt-export
conversation_id: 3e5008e1-131b-412c-849d-fcd2df38099e
message_count: 2
tags: [chatgpt, import]
---
# HTML tabindex Attribute

> Conversation ID: 3e5008e1-131b-412c-849d-fcd2df38099e
> Created: 2023-05-04T22:44:09Z
> Updated: 2023-05-04T22:44:23Z
> Messages: 2

---

## User

tabindex=0

---

## Assistant

`tabindex=0` is an HTML attribute that can be added to an element to make it programmatically focusable. When an element has a `tabindex` attribute with a value of 0, it becomes part of the normal tab order of the page. This means that when a user navigates the page using the Tab key, the element will receive focus along with other interactive elements on the page such as links and form controls.

Adding `tabindex=0` to an element is useful when you want to make an element that is not natively interactive, such as a `div` or a `span`, focusable. This allows users to interact with the element using the keyboard, which can be important for users who rely on keyboard navigation due to mobility or accessibility issues.

It's worth noting that adding a `tabindex` attribute to an element can also have unintended consequences if not used properly. For example, setting a `tabindex` value greater than 0 can change the tab order of the page and create confusion for users. It's important to use `tabindex` thoughtfully and test your page thoroughly to ensure it is accessible and easy to navigate for all users.

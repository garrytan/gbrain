---
conversation_id: 457f2f90-bafa-477f-941e-c61b44aaffea
created: 2023-05-05
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: 'Tailwind: Style Placeholder Text'
type: note
updated: 2023-05-05
---

# Tailwind: Style Placeholder Text

**Related:** [[coding_web_dev]]

> Conversation ID: 457f2f90-bafa-477f-941e-c61b44aaffea
> Created: 2023-05-05T04:23:46Z
> Updated: 2023-05-05T04:24:05Z
> Messages: 4

---

## User

how can i style placeholder text differently when the input is not active. im using tialwind css

---

## Assistant

You can style the placeholder text differently when the input is not active by using the `placeholder` and `placeholder-shown` pseudo-classes in CSS. Here's an example using Tailwind CSS:

```
/* Style the placeholder text */
input::placeholder {
  color: gray;
}

/* Style the placeholder text when input is not active */
input:not(:focus)::placeholder {
  color: red;
}
```

In this example, the `::placeholder` pseudo-element is used to style the placeholder text of the input element. The `input:not(:focus)::placeholder` selector is then used to style the placeholder text when the input is not active, by changing the color to red.

You can adjust the styles to your liking by changing the CSS properties and values. Additionally, you can use any other Tailwind classes as needed to style your input elements.

---

## User

im using tailwind

---

## Assistant

Great! In that case, you can use the `placeholder-*` variants in Tailwind to style the placeholder text. Here's an example:

```
<input 
  type="text" 
  class="w-full px-4 py-2 placeholder-gray-500 placeholder-opacity-50 focus:placeholder-opacity-100 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
  placeholder="Enter your name"
>
```

In this example, the `placeholder-gray-500` class sets the color of the placeholder text to gray, and the `placeholder-opacity-50` class sets the opacity of the placeholder text to 50%. The `focus:placeholder-opacity-100` class sets the opacity of the placeholder


**Topic:** [[chatgpt-clusters/coding_web_dev]]

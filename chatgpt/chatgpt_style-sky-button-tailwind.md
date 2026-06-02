---
title: "Style sky button Tailwind"
type: note
created: 2024-06-21
updated: 2024-06-21
source: chatgpt-export
conversation_id: 038bc7aa-56de-4ee9-ae7b-5c5d2e0b72b4
message_count: 4
tags: [chatgpt, import, code]
---
# Style sky button Tailwind

> Conversation ID: 038bc7aa-56de-4ee9-ae7b-5c5d2e0b72b4
> Created: 2024-06-21T06:22:48Z
> Updated: 2024-06-21T06:23:17Z
> Messages: 4

---

## User

<button>
                    <a
                      href="https://neversayaword.com"
                      class="text-base font-semibold leading-7 text-sky-600"
                    >
                      Listen
                    </a>
                  </button>

Style this into a cool sky colored button with tailwind css

---

## Assistant

Here’s how you can style the button into a cool sky-colored button using Tailwind CSS:

```html
<button class="bg-sky-500 hover:bg-sky-700 text-white font-semibold py-2 px-4 rounded">
  <a href="https://neversayaword.com" class="text-base leading-7">
    Listen
  </a>
</button>
```

This code will create a button with a sky-blue background, white text, and rounded corners. The button background will darken slightly when hovered over for a cool effect.

---

## User

Add a play button

---

## Assistant

Here's an updated version of the button with a play icon included. I'll use an SVG for the play icon:

```html
<button class="bg-sky-500 hover:bg-sky-700 text-white font-semibold py-2 px-4 rounded inline-flex items-center">
  <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-5.197-3.018A1.5 1.5 0 008 9.393v5.214a1.5 1.5 0 001.555 1.243l5.197-3.018a1.5 1.5 0 000-2.654z"></path>
  </svg>
  <a href="https://neversayaword.com" class="text-base leading-7">
    Listen
  </a>
</button>
```

This code will create a button with a play icon to the left of the "Listen" text. The icon will match the color of the text and have a consistent style with the rest of the button.

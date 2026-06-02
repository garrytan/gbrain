---
title: "Hide Div with Custom CSS"
type: note
created: 2023-04-19
updated: 2023-04-19
source: chatgpt-export
conversation_id: 822e8c87-8f1e-47b3-9c2e-d1de8ee0fc24
message_count: 6
tags: [chatgpt, import, code]
---
# Hide Div with Custom CSS

> Conversation ID: 822e8c87-8f1e-47b3-9c2e-d1de8ee0fc24
> Created: 2023-04-19T16:29:04Z
> Updated: 2023-04-19T16:36:09Z
> Messages: 6

---

## User

write custom css to hide the div id="ps-desktop-widget__footer-container"

---

## Assistant

To hide the div with the id "ps-desktop-widget__footer-container" using CSS, you can use the following code:

```css
#ps-desktop-widget__footer-container {
    display: none;
}
```

This CSS code targets the specific element with the id "ps-desktop-widget__footer-container" and sets its display property to "none", which hides the element from view.

---

## User

didnt work

here's the full html
<div id="ps-desktop-widget__footer-container">
    <span id="ps-desktop-widget__footer-label">powered by</span>
    <a id="ps-desktop-widget__footer-link" href="https://postscript.io/sms-marketing-learn-more?utm_source=popup" target="_blank" aria-label="Powered by Postscript" data-popup-engagement="true">
      Postscript
    </a>
  </div>

i need css to make that link and text invisible to the user in some way

---

## Assistant

If the CSS code I provided earlier didn't work, it's possible that there might be some specificity issues or conflicting styles in your code.

You can try adding the `!important` rule to the `display: none;` property to ensure that it overrides any other styles that might be affecting the element. Here's the updated code:

```css
#ps-desktop-widget__footer-container {
    display: none !important;
}
```

This CSS code targets the element with the id "ps-desktop-widget__footer-container" and sets its display property to "none" with the `!important` rule to ensure that it takes precedence over any other styles that might be affecting the element. This will hide both the text and link inside the element from view.

---

## User

not doing it

---

## Assistant

If the CSS code I provided earlier is not working, there might be some issues with the specificity or conflicting styles in your code.

To ensure that the CSS code is correctly applied, you can try adding the CSS code inside a style tag in the head section of the HTML document, like this:

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    #ps-desktop-widget__footer-container {
      display: none !important;
    }
  </style>
</head>
<body>
  <div id="ps-desktop-widget__footer-container">
    <span id="ps-desktop-widget__footer-label">powered by</span>
    <a id="ps-desktop-widget__footer-link" href="https://postscript.io/sms-marketing-learn-more?utm_source=popup" target="_blank" aria-label="Powered by Postscript" data-popup-engagement="true">
      Postscript
    </a>
  </div>
</body>
</html>
```

Make sure that the CSS code is placed inside the `style` tags in the `head` section of the HTML document, and that the `id` attribute matches the ID of the element you want to hide.

If you're still having trouble hiding the element, there might be other styles in your code that are overriding the CSS you've added. In that case, you might need to use more specific selectors or add more styles to your CSS code to ensure that it takes precedence over any other styles.


**Topic:** [[chatgpt-clusters/coding_web_dev]]

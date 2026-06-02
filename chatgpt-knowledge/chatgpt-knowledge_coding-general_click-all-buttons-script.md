---
title: "Click All Buttons Script"
type: guide
created: 2024-05-08
updated: 2024-05-08
source: chatgpt-export
topic: coding-general
message_count: 8
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# Click All Buttons Script

> **Source:** ChatGPT conversation
> **Date:** 2024-05-08T23:35:28Z
> **Messages:** 8
> **Topic:** coding-general

## Question

fol-btn follow-button

i need to click all buttons with that class. Using chrome inspector console

## Answer

To click all buttons with the class `fol-btn follow-button` using the Chrome Inspector Console, you can use the following JavaScript code:

```javascript
document.querySelectorAll('.fol-btn.follow-button').forEach(button => button.click());
```

This code selects all elements with the class `fol-btn follow-button` and clicks each one. Make sure to confirm that automatically clicking buttons on a webpage aligns with the site's terms of service to avoid any issues.

## Question

i need to delay

## Answer

To add a delay between clicks on each button with the class `fol-btn follow-button`, you can use the following JavaScript code snippet in the Chrome Inspector Console. This example uses a delay of 1000 milliseconds (1 second) between each click:

```javascript
const buttons = document.querySelectorAll('.fol-btn.follow-button');
buttons.forEach((button, index) => {
  setTimeout(() => button.click(), index * 1000);
});
```

This code schedules each button to be clicked at intervals of 1 second. You can adjust the `1000` in the code to change the delay to whatever you need (it's in milliseconds).

## Question

document.querySelectorAll('.fol-btn.follow-button').forEach(button => button.click());


then refresh and wait 5 seconds and repeat

## Answer

To implement a loop that clicks all buttons with the class `fol-btn follow-button`, refreshes the page, waits for 5 seconds, and then repeats the process, you can use the following JavaScript code in the Chrome Inspector Console. This script will continuously perform these actions until you stop it manually:

```javascript
function clickButtonsAndRefresh() {
  // Click all buttons
  document.querySelectorAll('.fol-btn.follow-button').forEach(button => button.click());

  // Refresh the page after clicking the buttons
  setTimeout(() => {
    location.reload();

    // Wait 5 seconds after the page loads before running the function again
    setTimeout(clickButtonsAndRefresh, 5000);
  }, 1000); // Assuming the clicks and initial processing take 1 second to complete
}

// Start the loop
clickButtonsAndRefresh();
```

This script clicks all the buttons, waits 1 second to ensure all clicks are processed (you can adjust this delay based on the specific behavior of the website), then reloads the page. After the page is reloaded and 5 seconds have passed, it repeats the process. To stop the loop, you will need to close the tab or refresh the page manually without re-executing the script.

## Question

give me a uivision code

## Answer

To create a UI.Vision RPA (formerly Kantu) macro that clicks all buttons with the class `fol-btn follow-button`, refreshes the page, waits for 5 seconds, and then repeats the action, you can use the following JSON script. This script should be imported into your UI.Vision browser extension:

```json
{
  "Name": "ClickButtons_Refresh_Wait",
  "CreationDate": "2024-05-08",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore"
    },
    {
      "Command": "store",
      "Target": "60000",
      "Value": "!timeout_wait"
    },
    {
      "Command": "while_v2",
      "Target": "",
      "Value": "true"
    },
    {
      "Command": "bringBrowserToForeground",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "XType",
      "Target": "${KEY_F5}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "5000",
      "Value": ""
    },
    {
      "Command": "forEach",
      "Target": "xpath=//button[contains(@class, 'fol-btn') and contains(@class, 'follow-button')]",
      "Value": "loop"
    },
    {
      "Command": "click",
      "Target": "${!loopElement}",
      "Value": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "endWhile",
      "Target": "",
      "Value": ""
    }
  ]
}
```

### How to Use This Script:
1. **Import the Macro**: Open the UI.Vision extension, go to the macros tab, and import this JSON script.
2. **Run the Macro**: Select the imported macro and click 'play' to start the automation.

This script:
- Uses `!errorignore` to continue even if some elements are not found or clicks fail.
- Sets a long timeout to ensure UI.Vision waits for elements to be available.
- Continuously loops the script:
  - Refreshes the page with `XType` command sending `F5`.
  - Waits for 5 seconds to allow the page to load.
  - Uses a `forEach` loop to find and click each button that has the specified classes.
  - Loops back to refresh the page and repeat the process indefinitely.

To stop the script, you will need to manually interrupt it in the UI.Vision interface.

---
title: "Filter Follow Buttons"
type: guide
created: 2024-07-08
updated: 2024-07-08
source: chatgpt-export
topic: coding-general
message_count: 12
tags: [chatgpt, knowledge, coding-general]
---
# Filter Follow Buttons

> **Source:** ChatGPT conversation
> **Date:** 2024-07-08T00:18:38Z
> **Messages:** 12
> **Topic:** coding-general

## Question

{
  "Name": "Thematic",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "2000",
      "Value": "!timeout_wait",
      "Description": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//*[@id=\"__layout\"]/div/div[4]/div/div/div/div[14]/div/div/div/div/div/div/div/div/div[2]/button",
      "Value": "200",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//*[@id=\"__layout\"]/div/div[4]/div/div/div/div[14]/div/div/div/div/div/div[2]/div/div/div[2]/button",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click"

## Answer

Here's the updated script to only click the button if it says "Follow" and not if it says "Following":

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "2000",
      "Value": "!timeout_wait",
      "Description": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "Math.floor(Math.random() * (300 - 50 + 1)) + 50",
      "Value": "randomDelay",
      "Description": "Calculate a random delay between 0.5 and 3 seconds"
    },
    {
      "Command": "executeScript",
      "Target": "Array.from(document.querySelectorAll('#__layout .btn')).filter(btn => btn.innerText === 'Follow').forEach(btn => btn.click());",
      "Value": "",
      "Description": "Click only buttons with text 'Follow'"
    },
    {
      "Command": "pause",
      "Target": "${randomDelay}",
      "Value": "",
      "Description": "Pause for the random delay calculated"
    }
  ]
}
```

This script uses `executeScript` to filter out only the buttons with the text "Follow" and clicks them. The random delay ensures that the clicks are spaced out randomly between 0.5 and 3 seconds.

## Question

its very slow

## Answer

To improve the speed while ensuring the buttons with the text "Follow" are clicked, you can adjust the script to process the clicks more efficiently. Here's an optimized version:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "2000",
      "Value": "!timeout_wait",
      "Description": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "var buttons = Array.from(document.querySelectorAll('#__layout .btn')).filter(btn => btn.innerText === 'Follow'); buttons.forEach(btn => btn.click());",
      "Value": "",
      "Description": "Click only buttons with text 'Follow'"
    }
  ]
}
```

In this updated script, the `executeScript` command filters and clicks all the "Follow" buttons in a single execution, which should be faster than processing them individually with a delay. This way, the entire operation is handled by the browser's JavaScript engine in one go, significantly improving the speed.

## Question

ok on this code:

{
  "Name": "Thematic Profiles",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "2000",
      "Value": "!timeout_wait",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "731364",
      "Value": "profileId",
      "Description": "Start with the given profile ID"
    },
    {
      "Command": "label",
      "Target": "start",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Navigating to profile ${profileId}",
      "Value": "",
      "Description": "Log current profile ID"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${profileId}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "D

## Answer

Sure, you can hard code 10 URLs to visit and click the "Follow" button if it is present and says "Follow". Here's an updated version of your script to do that:

```json
{
  "Name": "Thematic Profiles",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "2000",
      "Value": "!timeout_wait",
      "Description": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731364",
      "Value": "",
      "Description": "Profile 1"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731363",
      "Value": "",
      "Description": "Profile 2"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731362",
      "Value": "",
      "Description": "Profile 3"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731361",
      "Value": "",
      "Description": "Profile 4"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731360",
      "Value": "",
      "Description": "Profile 5"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731359",
      "Value": "",
      "Description": "Profile 6"
    },
    {
      "Command": "waitForPageToL

*(Answer truncated — 5252 chars total)*

## Question

its pausing a long time after page load

## Answer

To reduce the pause time after the page loads, you can remove the unnecessary `pause` command and instead rely on the `waitForPageToLoad` command to ensure the page is loaded before interacting with it. Here is the updated script:

```json
{
  "Name": "Thematic Profiles",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "2000",
      "Value": "!timeout_wait",
      "Description": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731364",
      "Value": "",
      "Description": "Profile 1"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731363",
      "Value": "",
      "Description": "Profile 2"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731362",
      "Value": "",
      "Description": "Profile 3"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731361",
      "Value": "",
      "Description": "Profile 4"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731360",
      "Value": "",
      "Description": "Profile 5"
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/731359",
      "Value": "",
      "

*(Answer truncated — 5388 chars total)*

## Question

lets roate to 10 new urls based on whats next if we decrement

## Answer

Sure, I'll create the script to handle 10 new URLs by decrementing the profile ID starting from a given profile ID. Here's the updated script:

```json
{
  "Name": "Thematic Profiles",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "true",
      "Value": "!errorignore",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "2000",
      "Value": "!timeout_wait",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "731364",
      "Value": "profileId",
      "Description": "Start with the given profile ID"
    },
    {
      "Command": "label",
      "Target": "start",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Navigating to profile ${profileId}",
      "Value": "",
      "Description": "Log current profile ID"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${profileId}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "waitForPageToLoad",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "xpath=//button[contains(text(), 'Follow')]",
      "Value": "",
      "Description": "Click the follow button if it says 'Follow'"
    },
    {
      "Command": "storeEval",
      "Target": "${profileId} - 1",
      "Value": "profileId",
      "Description": "Decrement the profile ID"
    },
    {
      "Command": "echo",
      "Target": "Next profile ID: ${profileId}",
      "Value": "",
      "Description": "Log the next profile ID"
    },
    {
      "Command": "gotoIf",
      "Target": "${profileId} > 731354",
      "Value": "start",
      "Description": "Repeat for the next profile ID until the last one is reached"
    }
  ]
}
```

This script starts at profile ID 731364 and decrements the profile ID by 1 in each iteration until it reaches 731354. It logs the current and next profile IDs, opens each profile URL, and clicks the "Follow" button if it says "Follow".

## Question

lets make a bookmark button on our chrome browser that clicks all the follow buttons

## Answer

Creating a bookmarklet that clicks all the "Follow" buttons on a page can be a convenient way to automate this process in your browser. Here’s how you can create a bookmarklet for Chrome that clicks all buttons with the text "Follow":

1. Open Chrome.
2. Right-click on the bookmarks bar and select "Add page..." (if you don't see the bookmarks bar, press `Ctrl+Shift+B` to show it).
3. Name your bookmark something like "Follow All".
4. In the URL field, paste the following JavaScript code:

```javascript
javascript:(function() {
  var buttons = document.querySelectorAll('button');
  buttons.forEach(function(button) {
    if (button.innerText === 'Follow') {
      button.click();
    }
  });
})();
```

5. Click "Save".

Now, whenever you are on a page with "Follow" buttons, you can click the "Follow All" bookmarklet to automatically click all the "Follow" buttons.

### Explanation
- This bookmarklet uses an IIFE (Immediately Invoked Function Expression) to run the code immediately.
- `document.querySelectorAll('button')` selects all button elements on the page.
- The `forEach` method iterates over each button, checking if its text content is "Follow".
- If a button's text is "Follow", the `click()` method is called on it to simulate a click.

This method is straightforward and should work well for your needs. If you need further customization or encounter any issues, feel free to ask!

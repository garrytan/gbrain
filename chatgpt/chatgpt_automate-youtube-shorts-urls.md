---
title: "Automate YouTube Shorts URLs"
type: guide
created: 2024-08-07
updated: 2024-08-07
source: chatgpt-export
conversation_id: 1b1acca7-f58c-4438-a6a3-470cc895a589
message_count: 2
tags: [chatgpt, import, code]
---
# Automate YouTube Shorts URLs

> Conversation ID: 1b1acca7-f58c-4438-a6a3-470cc895a589
> Created: 2024-08-07T21:30:02Z
> Updated: 2024-08-07T21:30:31Z
> Messages: 2

---

## User

Hey, so here's what I need. I need for... I have a spreadsheet where I'm going to put in YouTube URLs. And I need every URL in that spreadsheet to have slash shorts at the end, so it goes to the YouTube Shorts page, instead of just the traditional YouTube URL. The problem is that there's a bunch of other people using this sheet, and they're all morons. So they're not going to put slash shorts at the end, but some people will. So what I need to do is create some kind of a conditional property, some kind of formula, where it will automatically append slash shorts if slash shorts does not already exist. Is there some kind of code you can write for me, or a script, or a conditional property, or something that I can just bake right into the spreadsheet, where it automatically adds a slash shorts to the end of any URL that does not already have it, and skips ones that already have it.

---

## Assistant

You can use Google Sheets to achieve this with a formula. Here's a step-by-step guide on how to create a conditional formula that appends `/shorts` to the end of a YouTube URL if it doesn't already have it:

1. **Open your Google Sheet** where you have the YouTube URLs.

2. **Assume your URLs are in column A** starting from cell A1. You can use column B to store the modified URLs.

3. **In cell B1**, enter the following formula:

    ```excel
    =IF(RIGHT(A1, 7) = "/shorts", A1, A1 & "/shorts")
    ```

4. **Drag the fill handle** (a small square at the bottom-right corner of the cell) down to apply this formula to other cells in column B.

### Explanation:
- `RIGHT(A1, 7)` checks the last 7 characters of the URL in cell A1.
- `IF(RIGHT(A1, 7) = "/shorts", A1, A1 & "/shorts")` is a conditional statement:
  - If the last 7 characters are `/shorts`, it returns the original URL.
  - Otherwise, it appends `/shorts` to the URL.

### Example:
- If `A1` contains `https://www.youtube.com/watch?v=abc123`, `B1` will become `https://www.youtube.com/watch?v=abc123/shorts`.
- If `A2` contains `https://www.youtube.com/shorts/abc123`, `B2` will remain `https://www.youtube.com/shorts/abc123`.

This formula ensures that all URLs in column A are correctly formatted in column B, even if the original URL already contains `/shorts`.

If you want a script for more advanced usage or automation beyond this simple formula, here’s a Google Apps Script:

### Google Apps Script:
1. **Open your Google Sheet**.
2. Click on **Extensions > Apps Script**.
3. Delete any code in the script editor and paste the following script:

    ```javascript
    function appendShorts() {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
      var range = sheet.getDataRange();
      var values = range.getValues();

      for (var i = 0; i < values.length; i++) {
        var url = values[i][0];
        if (url && !url.endsWith('/shorts')) {
          values[i][0] = url + '/shorts';
        }
      }
      range.setValues(values);
    }
    ```

4. Click on the **Save** icon (or press `Ctrl + S`) and name your project.
5. Close the Apps Script tab.

### To run the script:
1. Go back to your Google Sheet.
2. Click on **Extensions > Macros > Manage macros**.
3. Add a new macro and link it to the `appendShorts` function.
4. Now, you can run this macro by going to **Extensions > Macros** and selecting `appendShorts`.

This script will modify the URLs in place, appending `/shorts` to any URL that doesn't already end with it.

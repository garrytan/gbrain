
Given that the CSV read method didn't work and you're using a simpler increment version, let's adapt the retry logic directly into your existing script without relying on CSV for storing the page numbers. We can add a retry mechanism for the page load and ensure we store the last successful page number in local storage to resume later.

Here’s how you can incorporate a retry mechanism and save the last page number to local storage:

```json
{
  "Name": "Increment Test with Retry and Save",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "executeScript_Sandbox",
      "Target": "return localStorage.getItem('lastPageNumber') || 1;",
      "Value": "pageNumber",
      "Description": "Get last page number from local storage or start from 1"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount",
      "Description": "Initialize retry count"
    },
    {
      "Command": "while_v2",
      "Target": "${retryCount} < 3",
      "Value": "",
      "Description": "Retry loop for page load"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "10000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.readyState === 'complete';",
      "Value": "pageLoaded",
      "Description": "Check if page is fully loaded"
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "break",
      "Target": "",
      "Value": "",
      "Description": "Exit retry loop if page loaded"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "${retryCount} + 1",
      "Value": "retryCount",
      "Description": "Increment retry count"
    },
    {
      "Command": "echo",
      "Target": "Retrying... (${retryCount})",
      "Value": "red",
      "Description": "Log retry attempt"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${retryCount} == 3",
      "Value": "",
      "Description": "Check if max retries reached"
    },
    {
      "Command": "echo",
      "Target": "Failed to load page ${pageNumber}",
      "Value": "red",
      "Description": "Log failure to load page"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": "Increment page number on failure"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "localStorage.setItem('lastPageNumber', '${pageNumber}');",
      "Value": "",
      "Description": "Save last page number to local storage"
    },
    {
      "Command": "continue",
      "Target": "",
      "Value": "",
      "Description": "Continue to next iteration"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "localStorage.setItem('lastPageNumber', '${pageNumber}');",
      "Value": "",
      "Description": "Save last page number to local storage"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    }
  ]
}
```

In this script:
- The `executeScript_Sandbox` command is used to get and set the `lastPageNumber` from and to local storage.
- A retry mechanism is added to attempt loading the page up to three times if it fails to load initially.
- If the page fails to load after three retries, it logs the failure and continues to the next page.
- The current page number is saved to local storage after each iteration, ensuring you can resume from the last successful page if the script is restarted.

This approach should help handle occasional page load failures and allow you to resume from where you left off.


start on page 17


To start the script on page 17 and implement the retry logic while saving the progress in local storage, you can adjust the initial value of `pageNumber` and ensure the script increments and stores the progress correctly. Here is the updated script:

```json
{
  "Name": "Increment Test with Retry and Save",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "executeScript_Sandbox",
      "Target": "return localStorage.getItem('lastPageNumber') || 17;",
      "Value": "pageNumber",
      "Description": "Get last page number from local storage or start from 17"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount",
      "Description": "Initialize retry count"
    },
    {
      "Command": "while_v2",
      "Target": "${retryCount} < 3",
      "Value": "",
      "Description": "Retry loop for page load"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "10000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.readyState === 'complete';",
      "Value": "pageLoaded",
      "Description": "Check if page is fully loaded"
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "break",
      "Target": "",
      "Value": "",
      "Description": "Exit retry loop if page loaded"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "${retryCount} + 1",
      "Value": "retryCount",
      "Description": "Increment retry count"
    },
    {
      "Command": "echo",
      "Target": "Retrying... (${retryCount})",
      "Value": "red",
      "Description": "Log retry attempt"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${retryCount} == 3",
      "Value": "",
      "Description": "Check if max retries reached"
    },
    {
      "Command": "echo",
      "Target": "Failed to load page ${pageNumber}",
      "Value": "red",
      "Description": "Log failure to load page"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": "Increment page number on failure"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "localStorage.setItem('lastPageNumber', '${pageNumber}');",
      "Value": "",
      "Description": "Save last page number to local storage"
    },
    {
      "Command": "continue",
      "Target": "",
      "Value": "",
      "Description": "Continue to next iteration"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "localStorage.setItem('lastPageNumber', '${pageNumber}');",
      "Value": "",
      "Description": "Save last page number to local storage"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    }
  ]
}
```

This updated script:
1. Starts from page 17 or from the last saved page number in local storage.
2. Implements a retry mechanism for loading pages, retrying up to 3 times.
3. Saves the current page number to local storage after each iteration.
4. Handles page load failures by incrementing the page number and logging the failure.

With this setup, the script will resume from where it left off if restarted, and it will handle retries for page load issues.


: localStorage is not defined


If `localStorage` is not accessible directly in the context of the script, we can use the `executeScript` command to interact with it.

Let's revise the script to use the `executeScript` command for reading and writing the `lastPageNumber`:

```json
{
  "Name": "Increment Test with Retry and Save",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "executeScript",
      "Target": "return localStorage.getItem('lastPageNumber') ? parseInt(localStorage.getItem('lastPageNumber')) : 17;",
      "Value": "pageNumber",
      "Description": "Get last page number from local storage or start from 17"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount",
      "Description": "Initialize retry count"
    },
    {
      "Command": "while_v2",
      "Target": "${retryCount} < 3",
      "Value": "",
      "Description": "Retry loop for page load"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "10000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.readyState === 'complete';",
      "Value": "pageLoaded",
      "Description": "Check if page is fully loaded"
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "break",
      "Target": "",
      "Value": "",
      "Description": "Exit retry loop if page loaded"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "${retryCount} + 1",
      "Value": "retryCount",
      "Description": "Increment retry count"
    },
    {
      "Command": "echo",
      "Target": "Retrying... (${retryCount})",
      "Value": "red",
      "Description": "Log retry attempt"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${retryCount} == 3",
      "Value": "",
      "Description": "Check if max retries reached"
    },
    {
      "Command": "echo",
      "Target": "Failed to load page ${pageNumber}",
      "Value": "red",
      "Description": "Log failure to load page"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": "Increment page number on failure"
    },
    {
      "Command": "executeScript",
      "Target": "localStorage.setItem('lastPageNumber', '${pageNumber}');",
      "Value": "",
      "Description": "Save last page number to local storage"
    },
    {
      "Command": "continue",
      "Target": "",
      "Value": "",
      "Description": "Continue to next iteration"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "localStorage.setItem('lastPageNumber', '${pageNumber}');",
      "Value": "",
      "Description": "Save last page number to local storage"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    }
  ]
}
```

In this script:
1. The `executeScript` command is used to read and write the `lastPageNumber` to local storage.
2. The script starts from page 17 or from the last saved page number.
3. Implements a retry mechanism for loading pages, retrying up to 3 times.
4. Saves the current page number to local storage after each iteration.
5. Handles page load failures by incrementing the page number and logging the failure.

With these adjustments, the script should be able to resume from where it left off and handle page load issues effectively.


i siwtched the storage mode on ui vision to file system. does that fix the csv read problem



Switching the storage mode to file system should indeed fix issues related to reading and writing CSV files in UI Vision. Here’s the updated script that uses the CSV file to read and write the last page number, taking into account your initial approach:

1. **Initial Setup**: Read the starting page number from the CSV file or default to 17 if the file is empty or not found.
2. **Loop and Retry Logic**: Implement the page load retry logic.
3. **Save Progress**: Save the last page number to the CSV file after each iteration.

Here’s how the updated script would look:

```json
{
  "Name": "Increment Test with Retry and Save",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "17",
      "Value": "defaultPageNumber",
      "Description": "Default start page number"
    },
    {
      "Command": "csvRead",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber",
      "Description": "Read the last page number from CSV"
    },
    {
      "Command": "if_v2",
      "Target": "${pageNumber}",
      "Value": "",
      "Description": "Check if pageNumber is set"
    },
    {
      "Command": "store",
      "Target": "${defaultPageNumber}",
      "Value": "pageNumber",
      "Description": "Use default page number if CSV is empty"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount",
      "Description": "Initialize retry count"
    },
    {
      "Command": "while_v2",
      "Target": "${retryCount} < 3",
      "Value": "",
      "Description": "Retry loop for page load"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "10000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.readyState === 'complete';",
      "Value": "pageLoaded",
      "Description": "Check if page is fully loaded"
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "break",
      "Target": "",
      "Value": "",
      "Description": "Exit retry loop if page loaded"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "${retryCount} + 1",
      "Value": "retryCount",
      "Description": "Increment retry count"
    },
    {
      "Command": "echo",
      "Target": "Retrying... (${retryCount})",
      "Value": "red",
      "Description": "Log retry attempt"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${retryCount} == 3",
      "Value": "",
      "Description": "Check if max retries reached"
    },
    {
      "Command": "echo",
      "Target": "Failed to load page ${pageNumber}",
      "Value": "red",
      "Description": "Log failure to load page"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": "Increment page number on failure"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "${pageNumber}",
      "Description": "Save last page number to CSV"
    },
    {
      "Command": "continue",
      "Target": "",
      "Value": "",
      "Description": "Continue to next iteration"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "${pageNumber}",
      "Description": "Save last page number to CSV"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    }
  ]
}
```

In this script:
- We read the `pageNumber` from `pageNumbers.csv` or default to 17 if the CSV file is empty.
- We implement the retry logic to handle page load issues.
- We save the last `pageNumber` to `pageNumbers.csv` after each iteration.

This should ensure that the script starts from the correct page and continues correctly while handling any page load issues.


Executing:  | store | 17 | defaultPageNumber | 
[info]
Executing:  | csvRead | pageNumbers.csv | pageNumber | 
[warning]
Line 2: csvRead: Value field should be empty (not used)
[error]
Line 2: E325: csv file 'pageNumbers.csv' does not exist
[info]
Macro failed (Runtime 0.41s)


It looks like the script failed because the CSV file does not exist or was not properly accessed. We can make sure that the script handles the situation when the CSV file is missing and create the file if it doesn't exist. 

Here is the updated script:

1. **Initial Setup**: Check if the CSV file exists. If it doesn't, start from page 17 and create the file.
2. **Loop and Retry Logic**: Implement the page load retry logic.
3. **Save Progress**: Save the last page number to the CSV file after each iteration.

Here's the revised script:

```json
{
  "Name": "Increment Test with Retry and Save",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "17",
      "Value": "defaultPageNumber",
      "Description": "Default start page number"
    },
    {
      "Command": "csvRead",
      "Target": "pageNumbers.csv",
      "Value": "",
      "Description": "Read the last page number from CSV"
    },
    {
      "Command": "if_v2",
      "Target": "${!csvReadStatus}",
      "Value": "false",
      "Description": "Check if CSV read was successful"
    },
    {
      "Command": "store",
      "Target": "${defaultPageNumber}",
      "Value": "pageNumber",
      "Description": "Use default page number if CSV read fails"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "${!csvReadLine}",
      "Value": "pageNumber",
      "Description": "Use page number from CSV if read is successful"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount",
      "Description": "Initialize retry count"
    },
    {
      "Command": "while_v2",
      "Target": "${retryCount} < 3",
      "Value": "",
      "Description": "Retry loop for page load"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "10000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.readyState === 'complete';",
      "Value": "pageLoaded",
      "Description": "Check if page is fully loaded"
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "break",
      "Target": "",
      "Value": "",
      "Description": "Exit retry loop if page loaded"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "${retryCount} + 1",
      "Value": "retryCount",
      "Description": "Increment retry count"
    },
    {
      "Command": "echo",
      "Target": "Retrying... (${retryCount})",
      "Value": "red",
      "Description": "Log retry attempt"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${retryCount} == 3",
      "Value": "",
      "Description": "Check if max retries reached"
    },
    {
      "Command": "echo",
      "Target": "Failed to load page ${pageNumber}",
      "Value": "red",
      "Description": "Log failure to load page"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": "Increment page number on failure"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "${pageNumber}",
      "Description": "Save last page number to CSV"
    },
    {
      "Command": "continue",
      "Target": "",
      "Value": "",
      "Description": "Continue to next iteration"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "${pageNumber}",
      "Description": "Save last page number to CSV"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    }
  ]
}
```

In this script:
- The `csvRead` command tries to read the `pageNumbers.csv` file. If the read fails (`!csvReadStatus` is `false`), it defaults to `defaultPageNumber` (17).
- If the read is successful, it uses the page number from the CSV.
- Implements the retry mechanism for page load issues.
- Saves the last page number to the CSV file after each iteration.


[error]
Line 2: E325: csv file 'pageNumbers.csv' does not exist
[info]
Macro failed (Runtime 0.38s)


To handle the situation where the CSV file might not exist initially, we can add a step to create the CSV file if it doesn't exist. This ensures that the script will not fail due to the missing file.

Here is the updated script that includes creating the CSV file if it does not exist:

```json
{
  "Name": "Increment Test with Retry and Save",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "17",
      "Value": "defaultPageNumber",
      "Description": "Default start page number"
    },
    {
      "Command": "executeScript",
      "Target": "return (typeof uiVision !== 'undefined' && uiVision.checkFileExists) ? uiVision.checkFileExists('pageNumbers.csv') : false;",
      "Value": "csvExists",
      "Description": "Check if the CSV file exists"
    },
    {
      "Command": "if_v2",
      "Target": "${csvExists}",
      "Value": "false",
      "Description": "If CSV does not exist, create it"
    },
    {
      "Command": "executeScript",
      "Target": "return '';",
      "Value": "dummyValue",
      "Description": "Create a dummy value"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "${dummyValue}",
      "Description": "Create the CSV file"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": "End CSV creation block"
    },
    {
      "Command": "csvRead",
      "Target": "pageNumbers.csv",
      "Value": "",
      "Description": "Read the last page number from CSV"
    },
    {
      "Command": "if_v2",
      "Target": "${!csvReadStatus}",
      "Value": "false",
      "Description": "Check if CSV read was successful"
    },
    {
      "Command": "store",
      "Target": "${defaultPageNumber}",
      "Value": "pageNumber",
      "Description": "Use default page number if CSV read fails"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "${!csvReadLine}",
      "Value": "pageNumber",
      "Description": "Use page number from CSV if read is successful"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount",
      "Description": "Initialize retry count"
    },
    {
      "Command": "while_v2",
      "Target": "${retryCount} < 3",
      "Value": "",
      "Description": "Retry loop for page load"
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "10000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.readyState === 'complete';",
      "Value": "pageLoaded",
      "Description": "Check if page is fully loaded"
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "break",
      "Target": "",
      "Value": "",
      "Description": "Exit retry loop if page loaded"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "storeEval",
      "Target": "${retryCount} + 1",
      "Value": "retryCount",
      "Description": "Increment retry count"
    },
    {
      "Command": "echo",
      "Target": "Retrying... (${retryCount})",
      "Value": "red",
      "Description": "Log retry attempt"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${retryCount} == 3",
      "Value": "",
      "Description": "Check if max retries reached"
    },
    {
      "Command": "echo",
      "Target": "Failed to load page ${pageNumber}",
      "Value": "red",
      "Description": "Log failure to load page"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": "Increment page number on failure"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "${pageNumber}",
      "Description": "Save last page number to CSV"
    },
    {
      "Command": "continue",
      "Target": "",
      "Value": "",
      "Description": "Continue to next iteration"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true",
      "Description": ""
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText",
      "Description": ""
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "${pageNumber}",
      "Description": "Save last page number to CSV"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    }
  ]
}
```

In this script:
- We check if the `pageNumbers.csv` file exists using `executeScript` with a custom JavaScript function `uiVision.checkFileExists`.
- If the CSV file does not exist, we create it with a dummy value to initialize it.
- We proceed to read the last page number from the CSV file or use the default value if the file is empty or does not exist.
- The rest of the script implements the retry logic and saves the last page number to the CSV file after each iteration.


ror]
Line 2: E325: csv file 'pageNumbers.csv' does not exist
[info]
Macro failed (Runtime 0.40s)

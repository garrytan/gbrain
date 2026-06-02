---
title: "Visit Google Pages RPA"
type: essay
created: 2024-07-08
updated: 2024-07-08
source: chatgpt-export
conversation_id: f5bd4749-1de6-4eec-a682-6085b2b79424
message_count: 44
tags: [chatgpt, import, code, long-form]
---
# Visit Google Pages RPA

> Conversation ID: f5bd4749-1de6-4eec-a682-6085b2b79424
> Created: 2024-07-08T03:32:39Z
> Updated: 2024-07-08T04:28:10Z
> Messages: 44


write json for a ui vison script that goes to https://google.com/1 then https://google.com/2 then coninue incrementing the url till 100


Here's a JSON script for a UI Vision RPA that navigates to URLs incrementing from `https://google.com/1` to `https://google.com/100`:

```json
{
  "Name": "VisitGooglePages",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://google.com/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Visiting page ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script uses the `store` command to initialize the page number to 1, then uses a `while_v2` loop to increment the page number and visit each URL until it reaches `https://google.com/100`. The `open` command navigates to each URL, and the `executeScript_Sandbox` command increments the page number. The `echo` command logs the current page number for debugging purposes.


perfect now change the base url to 
https://app.hellothematic.com/creator/profile/


Here's the updated JSON script with the base URL changed to `https://app.hellothematic.com/creator/profile/`:

```json
{
  "Name": "VisitThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Visiting profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script will navigate to each creator profile URL from `https://app.hellothematic.com/creator/profile/1` to `https://app.hellothematic.com/creator/profile/100`.


perfect now check if the follow button says follow or following and if it says follow click it
the elemnt looks like this:
<div class="f-btn-wrapper" data-v-30a65d07=""><button class="fol-btn follow-button hover-thematic-buttons light-hover">
    Follow
  </button> <!----></div>


Here is the updated JSON script that includes checking if the follow button says "Follow" and clicking it if it does:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "waitForElementPresent",
      "Target": "css=.fol-btn-wrapper .follow-button",
      "Value": "5000"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn-wrapper .follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == Follow",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn-wrapper .follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script now includes steps to check if the follow button says "Follow" and clicks it if it does. The `storeText` command stores the button text in a variable called `followText`, and the `if_v2` command checks if this text equals "Follow". If it does, the `click` command clicks the follow button. The `echo` command logs the action for debugging purposes.


{'asset_pointer': 'file-service://file-wC6ryyjqQYCneYYxUlhd5ACq', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 370, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 56137, 'width': 615}


It appears there was an issue locating the element `css=.fol-btn-wrapper .follow-button`. This might be due to the page not loading completely before the script checks for the element.

Let's modify the script to include a longer wait time and ensure the element is fully loaded before proceeding. Also, let's make sure that the CSS selector is correct and handles possible slight variations in the class structure.

Here's the updated JSON script:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "5000",
      "Value": ""
    },
    {
      "Command": "waitForElementPresent",
      "Target": "css=.fol-btn-wrapper .fol-btn.follow-button",
      "Value": "10000"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn-wrapper .fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == Follow",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn-wrapper .fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script includes a pause after opening each URL to give the page enough time to load, and it increases the wait time for the element to be present. Adjusting the selector to match potential slight variations in the class structure might also help in locating the button. If the button classes are still not correct, please check the exact structure using the browser's developer tools and adjust the selector accordingly.


{'asset_pointer': 'file-service://file-2cUhdEWAZcC1Mo151l2yWfKl', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 425, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 55073, 'width': 557}
<button class="fol-btn follow-button hover-thematic-buttons light-hover">
    Follow
  </button>




It looks like the correct CSS selector for the follow button should be `.fol-btn.follow-button` without the `.fol-btn-wrapper` part. Let's adjust the script accordingly:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "5000",
      "Value": ""
    },
    {
      "Command": "waitForElementPresent",
      "Target": "css=.fol-btn.follow-button",
      "Value": "10000"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == Follow",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script uses the updated selector `css=.fol-btn.follow-button` to locate the follow button. It should resolve the issue and allow the script to detect and click the follow button when it says "Follow".


{'asset_pointer': 'file-service://file-sNN4kTN9VqTNJ0GCOsXQuWDa', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 618, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 90765, 'width': 744}


It seems the issue is that the text comparison needs to be done correctly in the script. The stored text should be compared as a string. Let's update the script to ensure the comparison is done correctly.

Here's the revised script:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "5000",
      "Value": ""
    },
    {
      "Command": "waitForElementPresent",
      "Target": "css=.fol-btn.follow-button",
      "Value": "10000"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This update ensures that the text comparison is done as a string by enclosing `'Follow'` in single quotes. This should resolve the issue and allow the script to detect and click the follow button when it says "Follow".


{'asset_pointer': 'file-service://file-cPijPoXYyJlN4iexS8skdqxU', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1385, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 207778, 'width': 749}
it made it to the second profile which i was already following then got an error


It looks like the issue may be related to the page not loading the button correctly or being in a different state when the script tries to interact with it. We can add some additional steps to handle the situation more gracefully, such as retrying the wait for the element and adding an extra pause to ensure the page is fully loaded.

Let's add an extra pause before checking the follow button and ensure the CSS selector is accurate:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": ""
    },
    {
      "Command": "waitForElementPresent",
      "Target": "css=.fol-btn.follow-button",
      "Value": "15000"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script includes:
- A longer initial pause to allow the page to load completely.
- An increased wait time for the follow button to ensure it's detected.
- Retains the rest of the logic to check the button text and click if it says "Follow".

This should help the script handle profiles that you are already following and ensure the follow button is correctly detected and clicked if necessary.


if im already following the element looks like this

<button class="fol-btn followed-button hover-thematic-buttons"><svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="check-circle" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" class="check-circle-follow svg-inline--fa fa-check-circle fa-w-16"><path fill="currentColor" d="M504 256c0 136.967-111.033 248-248 248S8 392.967 8 256 119.033 8 256 8s248 111.033 248 248zM227.314 387.314l184-184c6.248-6.248 6.248-16.379 0-22.627l-22.627-22.627c-6.248-6.249-16.379-6.249-22.628 0L216 308.118l-70.059-70.059c-6.248-6.248-16.379-6.248-22.628 0l-22.627 22.627c-6.248 6.248-6.248 16.379 0 22.627l104 104c6.249 6.249 16.379 6.249 22.628.001z" class=""></path></svg>
    Followed
  </button>


Let's update the script to account for the scenario where the button says "Followed" instead of "Follow". We'll adjust the script to handle both cases.

Here is the updated JSON script:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": ""
    },
    {
      "Command": "waitForElementPresent",
      "Target": "css=.fol-btn.follow-button, css=.fol-btn.followed-button",
      "Value": "15000"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button, css=.fol-btn.followed-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script does the following:
1. Opens each profile page.
2. Pauses to allow the page to load.
3. Waits for either the "Follow" or "Followed" button to be present.
4. Stores the text of the button.
5. Checks if the button text is "Follow" and clicks it if true, otherwise logs that the profile is already being followed.

This should handle both scenarios and proceed accordingly based on the button's state.



[error]
Line 5: timeout reached when looking for element 'css=.fol-btn.follow-button, css=.fol-btn.followed-button'


It seems that the combined CSS selector might not be working as intended. We can try checking for each element separately and handle both cases.

Here is the updated script with separate checks for the "Follow" and "Followed" buttons:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent"
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent} == true",
      "Value": ""
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

In this script:
1. We first check if the "Follow" button is present using a JavaScript snippet and store the result in `isFollowButtonPresent`.
2. If the "Follow" button is present, we then store its text in `followText`.
3. If the text is "Follow", we click the button and log the action.
4. If the text is not "Follow", we log that the profile is already being followed.
5. If the "Follow" button is not found, we log that the follow button is not found on the profile.

This approach ensures that we handle each state separately and provides clearer feedback in the logs.


Line 5: document is not defined


It appears that the `executeScript_Sandbox` command is not correctly referencing the document. Let's correct this by using the `executeScript` command instead.

Here is the updated script:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent"
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

In this script:
- We use the `executeScript` command to run JavaScript that checks if the "Follow" button is present.
- The presence check result is stored in `isFollowButtonPresent`.
- If the button is present, we proceed to store its text in `followText`.
- If the text is "Follow", we click the button.
- Logs are added to handle and differentiate the various states.


great it seems to be working now. is it possible we can store those page numbers so we start off where we left off?


Yes, you can store the page number where you left off so that you can resume from that point in the future. One way to do this is by saving the current page number to a CSV file and then reading from this file when you start the script again.

Here’s how you can update the script to save the page number to a CSV file:

1. **Save the page number to a CSV file after each iteration:**

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "csvRead",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber"
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent"
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

2. **Resume from the last saved page number:**

Before starting the loop, read the last page number from the CSV file and start from there:

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "csvRead",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber"
    },
    {
      "Command": "if_v2",
      "Target": "${pageNumber}",
      "Value": ""
    },
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent"
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

This script will save the current page number to `pageNumbers.csv` after each iteration and start from the last saved page number when restarted. This way, you can resume the script from where it left off.


we got the first 17 pages fine then

Line 3: Error #210: 'open' failed. No page load event detected after 10s (!TIMEOUT_WAIT). Error details: Error #220: Still same ipc secret(more info)


The error you're encountering suggests that there might be issues with page loading times or unexpected behavior on certain pages. To mitigate this, we can increase the pause duration and add retry logic for opening the pages. Let's also ensure that the CSV reading and saving operations are handled properly.

Here's the updated script with these adjustments:

1. **Retry Logic for Opening Pages:**

```json
{
  "Name": "VisitAndFollowThematicProfiles",
  "CreationDate": "2024-07-07",
  "Commands": [
    {
      "Command": "csvRead",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber"
    },
    {
      "Command": "if_v2",
      "Target": "${pageNumber}",
      "Value": ""
    },
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return true;",
      "Value": "pageLoaded"
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount"
    },
    {
      "Command": "while_v2",
      "Target": "${pageLoaded} == false && ${retryCount} < 3",
      "Value": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "10000",
      "Value": ""
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return document.readyState == 'complete';",
      "Value": "pageLoaded"
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded} == false",
      "Value": ""
    },
    {
      "Command": "storeEval",
      "Target": "${retryCount} + 1",
      "Value": "retryCount"
    },
    {
      "Command": "echo",
      "Target": "Retrying... (${retryCount})",
      "Value": "red"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "if_v2",
      "Target": "${pageLoaded} == false",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Failed to load page ${pageNumber}",
      "Value": "red"
    },
    {
      "Command": "executeScript_Sandbox",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber"
    },
    {
      "Command": "continue",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "pause",
      "Target": "7000",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return document.querySelector('.fol-btn.follow-button') != null;",
      "Value": "isFollowButtonPresent"
    },
    {
      "Command": "if_v2",
      "Target": "${isFollowButtonPresent}",
      "Value": "true"
    },
    {
      "Command": "storeText",
      "Target": "css=.fol-btn.follow-button",
      "Value": "followText"
    },
    {
      "Command": "if_v2",
      "Target": "${followText} == 'Follow'",
      "Value": ""
    },
    {
      "Command": "click",
      "Target": "css=.fol-btn.follow-button",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button clicked on profile ${pageNumber}",
      "Value": "green"
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Already following profile ${pageNumber}",
      "Value": "blue"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "else",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "echo",
      "Target": "Follow button not found on profile ${pageNumber}",
      "Value": "red"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    },
    {
      "Command": "executeScript",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber"
    },
    {
      "Command": "csvSave",
      "Target": "pageNumbers.csv",
      "Value": "pageNumber"
    },
    {
      "Command": "end",
      "Target": "",
      "Value": ""
    }
  ]
}
```

In this updated script:
- A retry mechanism is added to attempt loading the page up to three times if it fails to load initially.
- If the page fails to load after three retries, it logs the failure and continues to the next page.
- The current page number is saved to the `pageNumbers.csv` file after each iteration, ensuring you can resume from the last successful page if the script is restarted.

This approach should help handle occasional page load failures and allow you to resume from where you left off.


im not using the csv read version it didnt work im using this:
{
  "Name": "Increment Test",
  "CreationDate": "2024-7-7",
  "Commands": [
    {
      "Command": "store",
      "Target": "1",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "open",
      "Target": "https://app.hellothematic.com/creator/profile/${pageNumber}",
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
      "Command": "executeScript",
      "Target": "return Number(${pageNumber}) + 1;",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    }
  ]
}


## See Also
- [[chatgpt/chatgpt_visit-google-pages-rpa-part2]]
- [[chatgpt/chatgpt_visit-google-pages-rpa-part3]]
- [[chatgpt/chatgpt_google-sheets-current-date-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
- [[chatgpt/chatgpt_accident-liability-and-insurance-part1]]

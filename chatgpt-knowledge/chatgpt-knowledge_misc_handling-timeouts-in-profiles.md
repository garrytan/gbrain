---
title: "Handling Timeouts in Profiles"
type: essay
created: 2024-07-08
updated: 2024-07-08
source: chatgpt-export
topic: misc
message_count: 18
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Handling Timeouts in Profiles

> **Source:** ChatGPT conversation
> **Date:** 2024-07-08T08:53:56Z
> **Messages:** 18
> **Topic:** misc

## Question

{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Value": "fo

## Answer

To handle occasional timeouts, you can implement retries and error handling in your script. Below is an updated version of your script with added retry logic to handle timeouts and ensure robustness:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
      "Value": "pageNumber",
      "Description": ""
    },
    {
      "Command": "store",
      "Target": "0",
      "Value": "retryCount",
      "Description": ""
    },
    {
      "Command": "while_v2",
      "Target": "${pageNumber} <= 100",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "executeScript",
      "Target": "window.location.href='https://app.hellothematic.com/creator/profile/${page

## Question

if it times out we can just go to the next profile

## Answer

Got it. To handle timeouts by moving to the next profile, we can use a try-catch block within the while loop. Here's the updated script:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Command": "try",
      "Target": "",
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
      "Command": "catch",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Timeout or error on profile ${pageNumber}, moving to next profile",
      "Value": "orange",
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
      "Desc

*(Answer truncated — 3146 chars total)*

## Question

Storage Mode
Reload all resources on hard drive
More Info
Thematic
Table View
Source View (JSON)
Command
⋮
Target
⋮
Value
Ops
Command
command
Target
Value
Description
Logs
Variables
Screenshots
CSV
👁Visual
[info]
Executing:  | echo | Follow button not found on profile ${pageNumber} | red | 
[echo]
Follow button not found on profile 3
[info]
Executing:  | end |  |  | 
[info]
Executing:  | executeScript | return Number(${pageNumber}) + 1; | pageNumber | 
[info]
Executing:  | end |  |  | 
[info]
Executing:  | while_v2 | ${pageNumber} <= 100 |  | 
[info]
Executing:  | open | https://app.hellothematic.com/creator/profile/${pageNumber} |  | 
[info]
Macro was stopped manually (Runtime 47.34s)
[status]
Playing macro Increment Test
[info]
Executing:  | store | 1 | pageNumber | 
[info]
Executing:  | while_v2 | ${pageNumber} <= 100 |  | 
[info]
Executing:  | open | https://app.hellothematic.com/creator/profile/${pageNumber} |  | 
[info]
Executing:  | pause | 7000 |  | 
[info]
Executing:  | execut

## Answer

It seems there are several issues with the script, particularly around handling timeouts and ensuring the process continues smoothly. I'll simplify the script to make it robust against timeouts and proceed to the next profile automatically.

Here's the revised version of the script:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Command": "try",
      "Target": "",
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
      "Command": "catch",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Timeout or error on profile ${pageNumber}, moving to next profile",
      "Value": "orange",
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
      "Target": "return Number(${pageNumber}) 

*(Answer truncated — 3486 chars total)*

## Question

Line 2: localStorage is not defined

## Answer

It seems the localStorage-related lines are causing issues. Let's remove any attempts to use localStorage and keep the script focused on handling the profile processing without interruptions.

Here's the updated script without localStorage:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Command": "try",
      "Target": "",
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
      "Command": "catch",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Timeout or error on profile ${pageNumber}, moving to next profile",
      "Value": "orange",
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
      "

*(Answer truncated — 3356 chars total)*

## Question

Thematic
Table View
Source View (JSON)
Command
⋮
Target
⋮
Value
Ops
Command
command
Target
Value
Description
Logs
Variables
Screenshots
CSV
👁Visual
[status]
Playing macro Thematic
[error]
Line 1: No matching if/while/times/forEach for this end (at command #22)

## Answer

The error indicates that there is a mismatch in the script's control structures, particularly with the `end` commands. Let's carefully match all the `if`, `else`, `while`, `try`, and `catch` blocks with their corresponding `end` commands.

Here's the corrected version of the script:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Command": "try",
      "Target": "",
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
      "Command": "catch",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Timeout or error on profile ${pageNumber}, moving to next profile",
      "Value": "orange",
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
      "Target": "return Number(${pageNumber}) 

*(Answer truncated — 3428 chars total)*

## Question

Line 1: No matching if/while/times/forEach for this end (at command #22)

## Answer

It seems there is still a mismatch with the `end` commands. Let's ensure every block has a corresponding `end`. Here's the updated script with all blocks properly matched:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Command": "try",
      "Target": "",
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
      "Command": "end",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "catch",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Timeout or error on profile ${pageNumber}, moving to next profile",
      "Value": "orange",
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
     

*(Answer truncated — 3360 chars total)*

## Question

Line 1: No matching if/while/times/forEach for this end (at command #21)

## Answer

It seems there's still an issue with the matching of control structures. Let's re-examine and ensure all blocks are correctly matched. Here’s the revised script:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Command": "try",
      "Target": "",
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
      "Command": "catch",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Timeout or error on profile ${pageNumber}, moving to next profile",
      "Value": "orange",
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
      "Value": 

*(Answer truncated — 3351 chars total)*

## Question

the first script i gave you worked. this one does not. lets get back to a working script

## Answer

Understood. Let's revisit the original script and modify it to handle timeouts by simply moving on to the next profile without adding unnecessary complexity.

Here’s the original script with minimal changes to handle timeouts:

```json
{
  "Name": "Thematic",
  "CreationDate": "2024-7-8",
  "Commands": [
    {
      "Command": "store",
      "Target": "27",
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
      "Command": "try",
      "Target": "",
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
      "Command": "catch",
      "Target": "",
      "Value": "",
      "Description": ""
    },
    {
      "Command": "echo",
      "Target": "Timeout or error on profile ${pageNumber}, moving to next profile",
      "Value": "orange",
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
      "Description": 

*(Answer truncated — 3384 chars total)*

## Question

https://crawlee.dev/docs/quick-start

this is the site for crawlee explaining how to use it. lets use crawlee to build a webcrawler that does this task instead. 

## Answer

Sure, I can help you create a web crawler using Crawlee to perform the same task. Crawlee is a powerful web scraping and browser automation library. To get started, we need to set up a basic project and script.

Here’s how you can do it:

1. **Install Crawlee**: First, you need to install Crawlee. You can do this using npm.

    ```bash
    npm install crawlee
    ```

2. **Create a Crawler Script**: Create a new JavaScript file, for example, `thematic-crawler.js`, and add the following script to it.

```javascript
import { PuppeteerCrawler, log } from 'crawlee';

const crawler = new PuppeteerCrawler({
    requestHandler: async ({ page, request }) => {
        const { url } = request;
        log.info(`Crawling ${url}`);

        // Wait for the page to load
        await page.waitForTimeout(7000);

        // Check if the follow button is present
        const isFollowButtonPresent = await page.$('.fol-btn.follow-button');
        
        if (isFollowButtonPresent) {
            const followText = await page.$eval('.fol-btn.follow-button', el => el.textContent);
            if (followText.trim() === 'Follow') {
                await page.click('.fol-btn.follow-button');
                log.info(`Follow button clicked on profile ${request.userData.pageNumber}`);
            } else {
                log.info(`Already following profile ${request.userData.pageNumber}`);
            }
        } else {
            log.info(`Follow button not found on profile ${request.userData.pageNumber}`);
        }

        // Proceed to the next page
        const nextPageNumber = request.userData.pageNumber + 1;
        if (nextPageNumber <= 100) {
            await crawler.addRequests([
                {
                    url: `https://app.hellothematic.com/creator/profile/${nextPageNumber}`,
                    userData: { pageNumber: nextPageNumber }
                }
            ]);
        }
    },

    failedRequestHandler: async ({ request }) => {
        log.error(`Request ${request.url} failed too many times`);

        // Proceed to the next page even if the request failed
        const nextPageNumber = request.userData.pageNumber + 1;
        if (nextPageNumber <= 100) {
            await crawler.addRequests([
                {
                    url: `https://app.hellothematic.com/creator/profile/${nextPageNumber}`,
                    userData: { pageNumber: nextPageNumber }
                }
            ]);
        }
    }
});

// Start the crawler with the initial URL
await crawler.addRequests([
    {
        url: 'https://app.hellothematic.com/creator/profile/27',
        userData: { pageNumber: 27 }
    }
]);

await crawler.run();
```

3. **Run the Script**: Execute your script using Node.js.

    ```bash
    node thematic-crawler.js
    ```

This script will start at profile 27 and proceed to profile 100, checking for the follow button and clicking it if it’s not already followed. If it encounters any errors, it will log the error and procee

*(Answer truncated — 3741 chars total)*

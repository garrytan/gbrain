---
title: "Create JavaScript Bookmarklets."
type: guide
created: 2024-05-24
updated: 2024-05-24
source: chatgpt-export
topic: coding-web
message_count: 8
tags: [chatgpt, knowledge, coding-web]
---
# Create JavaScript Bookmarklets.

> **Source:** ChatGPT conversation
> **Date:** 2024-05-24T23:52:25Z
> **Messages:** 8
> **Topic:** coding-web

## Question

with arc browser can i save javascript code as buttons of somekind that i can click to tirgger running the code in the browser

## Answer

Yes, you can create bookmarklets in the Arc browser to save and run JavaScript code. A bookmarklet is a bookmark that contains JavaScript code instead of a URL. Here's how you can create one:

1. **Open the Arc browser.**

2. **Create a New Bookmark:**
   - Go to the bookmarks manager.
   - Create a new bookmark.

3. **Add JavaScript Code:**
   - In the URL field of the new bookmark, type `javascript:` followed by your JavaScript code. For example, if you want to create a bookmarklet to alert "Hello, world!", you would enter:
     ```javascript
     javascript:alert('Hello, world!');
     ```

4. **Save the Bookmark:**
   - Give your bookmark a name, such as "Alert Hello".
   - Save the bookmark.

5. **Use the Bookmarklet:**
   - Click on the bookmark you created. This will run the JavaScript code in the context of the current page.

Here's a more detailed example with a simple script to change the background color of the page:

1. Create a new bookmark.
2. In the URL field, enter the following:
   ```javascript
   javascript:document.body.style.backgroundColor='blue';
   ```
3. Name the bookmark "Change Background Color".
4. Save it and click on the bookmark to see the background color change.

By following these steps, you can create buttons (bookmarklets) in the Arc browser that execute your JavaScript code when clicked.

## Question

you cant run javascript from the address bar

## Answer

You can indeed create bookmarklets to run JavaScript code in browsers like Arc. Here’s a step-by-step guide to doing it, considering that you can't run JavaScript directly from the address bar:

1. **Open the Arc browser.**

2. **Create a New Bookmark:**
   - Navigate to the bookmarks manager or press `Ctrl+D` (or `Cmd+D` on Mac) to create a new bookmark.

3. **Add JavaScript Code:**
   - In the URL field of the new bookmark, type `javascript:` followed by your JavaScript code. For example, if you want to create a bookmarklet to alert "Hello, world!", you would enter:
     ```javascript
     javascript:alert('Hello, world!');
     ```

4. **Save the Bookmark:**
   - Give your bookmark a name, such as "Alert Hello".
   - Save the bookmark.

5. **Use the Bookmarklet:**
   - Navigate to the page where you want to run the JavaScript.
   - Click on the bookmark you created. This will run the JavaScript code in the context of the current page.

Here’s a more detailed example with a script to change the background color of the page:

1. Create a new bookmark.
2. In the URL field, enter the following:
   ```javascript
   javascript:(function(){document.body.style.backgroundColor='blue';})();
   ```
3. Name the bookmark "Change Background Color".
4. Save it and click on the bookmark to see the background color change.

This method ensures that the JavaScript code runs within the context of the current page when you click the bookmark.

## Question

how with this code:

function scrollAndClick() {
    // Select the modal element by class name or other unique identifier
    var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

    if (!modal) {
        console.log('Modal element not found');
        return;
    }

    var scrollCount = 0;
    var maxScrolls = 5;  // Number of scrolls before clicking all "Follow" buttons

    // Function to click all "Follow" buttons visible in the modal
    function clickFollowButtons() {
        // Select all buttons with the specific class
        const buttons = document.querySelectorAll('.harmony-7dahz9');
        let delay = 100;

        buttons.forEach((button, index) => {
            setTimeout(() => {
                button.click();
            }, delay * index);
        });
    }

    // Function to perform the scroll and click actions with random delays
    function performScrollAndClick() {
        if (scrollCount >= maxScrolls) {
            // Click th

## Answer

To run your JavaScript code in the Arc browser using a bookmarklet, you need to convert your code into a single-line format that can be executed from a bookmark. Here’s how you can do it:

1. **Minify the Code:**
   - Remove all unnecessary whitespace and line breaks to make the code a single line.

2. **Prefix with `javascript:`:**
   - Add the `javascript:` prefix to the minified code.

Here’s your provided code, converted into a bookmarklet format:

```javascript
javascript:(function(){function scrollAndClick(){var modal=document.querySelector('.Modal-module_body__efFIt .scrollbar-container');if(!modal){console.log('Modal element not found');return;}var scrollCount=0;var maxScrolls=5;function clickFollowButtons(){const buttons=document.querySelectorAll('.harmony-7dahz9');let delay=100;buttons.forEach((button,index)=>{setTimeout(()=>{button.click();},delay*index);});}function performScrollAndClick(){if(scrollCount>=maxScrolls){clickFollowButtons();scrollCount=0;}else{modal.scrollBy(0,100);scrollCount++;}var delay=Math.random()*(1500-500)+500;setTimeout(performScrollAndClick,delay);}clickFollowButtons();performScrollAndClick();}scrollAndClick();})();
```

3. **Create the Bookmarklet:**
   - Open the bookmarks manager in the Arc browser or press `Ctrl+D` (or `Cmd+D` on Mac) to create a new bookmark.
   - In the URL field of the new bookmark, paste the above code.
   - Name the bookmark something descriptive, like "Scroll and Click".
   - Save the bookmark.

4. **Use the Bookmarklet:**
   - Navigate to the page where you want to run the JavaScript.
   - Click on the bookmark you created. This will run the JavaScript code in the context of the current page.

This will allow you to execute your `scrollAndClick` function by simply clicking the bookmarklet.

## Question

in arc we have to use boosts

## Answer

In the Arc browser, you can use "Boosts" to inject custom JavaScript into web pages. Here’s how you can create a Boost to run your `scrollAndClick` function:

1. **Open Arc Browser and Access Boosts:**
   - Open the Arc browser.
   - Click on the "Arc" menu in the top-left corner and select "Boosts".

2. **Create a New Boost:**
   - Click on "Create New Boost".
   - Choose the option to create a "Custom Boost".

3. **Name Your Boost and Select the Site:**
   - Give your Boost a name, such as "Scroll and Click".
   - Enter the URL or domain of the site where you want to run your script.

4. **Add Your JavaScript Code:**
   - In the JavaScript section, paste your minified code. Here’s the minified version again for convenience:

   ```javascript
   function scrollAndClick(){var modal=document.querySelector('.Modal-module_body__efFIt .scrollbar-container');if(!modal){console.log('Modal element not found');return;}var scrollCount=0;var maxScrolls=5;function clickFollowButtons(){const buttons=document.querySelectorAll('.harmony-7dahz9');let delay=100;buttons.forEach((button,index)=>{setTimeout(()=>{button.click();},delay*index);});}function performScrollAndClick(){if(scrollCount>=maxScrolls){clickFollowButtons();scrollCount=0;}else{modal.scrollBy(0,100);scrollCount++;}var delay=Math.random()*(1500-500)+500;setTimeout(performScrollAndClick,delay);}clickFollowButtons();performScrollAndClick();}scrollAndClick();
   ```

5. **Save and Activate the Boost:**
   - Save your Boost.
   - Make sure it’s activated for the site you specified.

6. **Use the Boost:**
   - Navigate to the site where you want to run the script.
   - The Boost will automatically inject and run the `scrollAndClick` function on the specified site.

This method allows you to automate actions on a webpage using Arc's Boost feature.

---
title: "Automating Screen Clicks"
type: guide
created: 2024-09-04
updated: 2024-09-04
source: chatgpt-export
conversation_id: b287424f-ac3f-406d-b2d3-bd181b51cc13
message_count: 13
tags: [chatgpt, import, code, long-form]
---
# Automating Screen Clicks

> Conversation ID: b287424f-ac3f-406d-b2d3-bd181b51cc13
> Created: 2024-09-04T21:27:52Z
> Updated: 2024-09-04T21:37:48Z
> Messages: 13

---

## User

I need a free Mac app that will click on one point of my screen, then another, then another, and then repeat X times

---

## Assistant

For a free Mac app that can automate mouse clicks on different points of your screen in a sequence, you might want to try **Hammerspoon**. It's a powerful automation tool that lets you write scripts in Lua to control various aspects of your Mac, including mouse clicks.

Here's a basic script to achieve what you need:

1. **Install Hammerspoon** from [Hammerspoon's official website](https://www.hammerspoon.org/).
2. Once installed, open Hammerspoon and then click on the Hammerspoon icon in the menu bar, and choose `Open Config`.

3. In the configuration file (`init.lua`),

---

## Assistant

A free Mac app that can automate clicking on specific points on your screen is **Automator**, which is built into macOS. Here’s how you can set it up:

1. **Open Automator**:
   - Go to your Applications folder and launch Automator.

2. **Create a New Workflow**:
   - Choose "Workflow" when prompted.

3. **Set Up Your Click Actions**:
   - In the left-hand panel, search for "Run AppleScript" and drag it into your workflow.
   - Use the following AppleScript code to click on different screen points:

   ```applescript
   on run {input, parameters}
       tell application "System Events"
           repeat X times
               -- Replace with your coordinates
               click at {x1, y1}
               delay 1
               click at {x2, y2}
               delay 1
               click at {x3, y3}
               delay 1
           end repeat
       end tell
   end run
   ```

   Replace `X` with the number of times you want it to repeat and `x1, y1`, `x2, y2`, and `x3, y3` with the screen coordinates you want the clicks to occur.

4. **Save the Workflow**:
   - Save your workflow as an app, which you can run whenever needed.

If you prefer a third-party app with a graphical interface, you might want to consider **Hammerspoon** (free, open-source), which allows for more advanced automation with Lua scripting, or **Cliclick** (also free), which is a command-line tool that can be combined with simple shell scripts to achieve the same result.

For more intuitive apps with graphical interfaces, consider **Mouse Recorder** or **Jitbit Macro Recorder**. They aren’t always free but often have trial versions.

---

## User

Using hammerspoon

---

## Assistant

Here's how you can use **Hammerspoon** to automate clicking on specific points on your screen:

### 1. **Install Hammerspoon**:
   - Download and install Hammerspoon from [hammerspoon.org](https://www.hammerspoon.org/).

### 2. **Set Up the Configuration**:
   - Open Hammerspoon by clicking its icon in the menu bar.
   - Click on "Open Config" to open the `init.lua` configuration file in your default text editor.

### 3. **Write the Script**:
   - In the `init.lua` file, you can write a Lua script to automate the clicks. Here's an example:

   ```lua
   -- Define the points to click
   local points = {
       {x = 100, y = 200},  -- Point 1
       {x = 300, y = 400},  -- Point 2
       {x = 500, y = 600}   -- Point 3
   }

   -- Function to click at a given point
   local function clickPoint(point)
       hs.eventtap.leftClick(point)
   end

   -- Function to repeat clicks
   local function repeatClicks(repeatCount)
       for i = 1, repeatCount do
           for _, point in ipairs(points) do
               clickPoint(point)
               hs.timer.usleep(500000)  -- 0.5 second delay between clicks
           end
       end
   end

   -- Number of times to repeat the sequence
   local repeatCount = 10

   -- Run the click sequence
   repeatClicks(repeatCount)
   ```

   Replace the `x` and `y` values in the `points` table with the screen coordinates where you want the clicks to occur. Adjust the `repeatCount` to the number of times you want the sequence to repeat.

### 4. **Reload the Configuration**:
   - Save the `init.lua` file.
   - Click on the Hammerspoon icon in the menu bar and select "Reload Config" to apply your changes.

### 5. **Run the Script**:
   - The script will automatically run and start clicking on the specified points.

### 6. **Stop the Script**:
   - If you need to stop the script, you can do so by quitting Hammerspoon from the menu bar.

This setup allows you to automate clicks on your screen using Hammerspoon, providing a powerful and flexible way to control your Mac with Lua scripting.

---

## User

How do I escape

---

## Assistant

To safely stop or "escape" from an automated script running in Hammerspoon, especially if it's performing continuous actions like clicking, you can use the following methods:

### 1. **Use a Hotkey to Interrupt the Script**:
   - Modify your `init.lua` script to include a hotkey that can interrupt the automation. For example:

   ```lua
   local shouldStop = false

   -- Define the points to click
   local points = {
       {x = 100, y = 200},  -- Point 1
       {x = 300, y = 400},  -- Point 2
       {x = 500, y = 600}   -- Point 3
   }

   -- Function to click at a given point
   local function clickPoint(point)
       hs.eventtap.leftClick(point)
   end

   -- Function to repeat clicks
   local function repeatClicks(repeatCount)
       for i = 1, repeatCount do
           if shouldStop then break end
           for _, point in ipairs(points) do
               clickPoint(point)
               hs.timer.usleep(500000)  -- 0.5 second delay between clicks
               if shouldStop then break end
           end
       end
   end

   -- Hotkey to stop the script
   hs.hotkey.bind({"cmd", "ctrl"}, "Q", function()
       shouldStop = true
       hs.alert.show("Script Stopped")
   end)

   -- Number of times to repeat the sequence
   local repeatCount = 10

   -- Run the click sequence
   repeatClicks(repeatCount)
   ```

   In this script:
   - The `shouldStop` variable is used to control when to stop the script.
   - The hotkey `Cmd + Ctrl + Q` is bound to set `shouldStop` to `true`, effectively stopping the click automation.

### 2. **Force Quit Hammerspoon**:
   - If the script is unresponsive and you need to stop it immediately, you can force quit Hammerspoon:
     - Press `Cmd + Option + Esc` to open the Force Quit Applications window.
     - Select Hammerspoon and click "Force Quit."

### 3. **Reload the Configuration**:
   - Click on the Hammerspoon icon in the menu bar and select "Reload Config" to stop the current script and reload your configuration.

By using a hotkey to interrupt the script, you can safely stop the automation without needing to force quit Hammerspoon.

---

## User

Also I want to click a specific button in the chrome browser

---

## Assistant

To click a specific button in the Chrome browser using Hammerspoon, you'll need to combine Hammerspoon's capabilities with a bit of AppleScript to control Chrome. Here’s how you can do it:

### 1. **Identify the Button**:
   - First, identify the button you want to click in Chrome. You might need to inspect the button to find its properties like its label, class, or unique identifier (ID).

### 2. **Use AppleScript to Click the Button**:
   - You can use AppleScript to interact with Chrome's UI. Here's an example of a script that clicks a button with a specific label in Chrome:

   ```lua
   -- Function to click a button in Chrome by its label
   local function clickChromeButton(buttonLabel)
       local appleScript = [[
           tell application "Google Chrome"
               activate
               tell front window's active tab
                   execute javascript "document.querySelector('button[aria-label=']] .. buttonLabel .. [[']').click();"
               end tell
           end tell
       ]]
       hs.osascript.applescript(appleScript)
   end

   -- Example: Click a button with the label 'Sign In'
   clickChromeButton("Sign In")
   ```

   Replace `"Sign In"` with the label or attribute that uniquely identifies the button you want to click. If the button is identified by something other than an `aria-label`, you might need to adjust the JavaScript selector accordingly.

### 3. **Run the Script in Hammerspoon**:
   - Save the script in your `init.lua` file.
   - Reload your Hammerspoon configuration to run the script. It should automatically activate Chrome and click the specified button.

### 4. **Advanced Button Selection**:
   - If the button does not have an easily selectable label, you might need to use a more specific JavaScript selector based on the button's ID, class, or other attributes:

   ```lua
   -- Click button by ID
   local function clickButtonById(buttonId)
       local appleScript = [[
           tell application "Google Chrome"
               activate
               tell front window's active tab
                   execute javascript "document.getElementById(']] .. buttonId .. [[').click();"
               end tell
           end tell
       ]]
       hs.osascript.applescript(appleScript)
   end

   -- Example: Click a button with the ID 'submitButton'
   clickButtonById("submitButton")
   ```

### 5. **Testing and Debugging**:
   - Test the script to ensure it works as expected. If the button isn’t being clicked, double-check the JavaScript selector you’re using in the AppleScript to make sure it correctly targets the button.

This setup allows you to programmatically click a specific button in Chrome using Hammerspoon and AppleScript, making it flexible enough to handle various web elements.

---

## User

First click this

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 58.6720009" class="logo logo-desktop" data-v-148c7c28="" data-v-3d9a46ef=""><style data-v-148c7c28="">
    .st0 {
    fill: #fff;
    }
    .st1 {
    fill: #7c878c;
    }
    .st2 {
    fill: #1c242c;
    }
    .st3 {
    fill: #f2f2f2;
    }
    .st4 {
    fill: #def244;
    }
    .st5 {
    fill: #a6b533;
    }
    .st6 {
    fill: #f2fab4;
    }
    .st7 {
    fill: #63ffbd;
    }
    .st8 {
    fill: #4abf8e;
    }
    .st9 {
    fill: #c1ffe5;
    }
    .st10 {
    fill: #59befe;
    }
    .st11 {
    fill: #438fbf;
    }
    .st12 {
    fill: #bde5ff;
    }
    .st13 {
    fill: #49377c;
    }
    .st14 {
    fill: #312654;
    }
    .st15 {
    fill: #ada8bb;
    }
    .st16 {
    fill: #f21b91;
    }
    .st17 {
    fill: #b5146d;
    }
    .st18 {
    fill: #faa4d3;
    }
  </style> <g id="white" data-v-148c7c28=""><g id="horizontal_7_" data-v-148c7c28=""><g id="wordmark_23_" data-v-148c7c28=""><circle cx="247.307" cy="29.499" r="1.599" class="st0" data-v-148c7c28=""></circle> <path id="thematic_22_" d="M183.109 17.305l11.049 23.857H172.06l11.049-23.857zm-6.994 21.279h13.99l-6.996-15.14-6.994 15.14zM63.497 17.918h16.246v2.578H72.91v20.666h-2.578V20.496h-6.834v-2.578zm40.185 13.301H91.078v9.943H88.5V17.918h2.578V28.64h12.604V17.918h2.578v23.244h-2.578V31.22zm15.592-2.62h10.148v2.579h-10.19v7.406h12.81v2.578h-15.387V17.918h15.386v2.578h-12.767V28.6zm44.645-11.294v23.857h-2.578V24.628l-8.47 10.029-8.471-10.029v16.534h-2.578V17.305l11.049 13.257 11.048-13.257zm34.546.613h16.246v2.578h-6.834v20.666H205.3V20.496h-6.834v-2.578zm25.001 0h2.579v23.244h-2.579V17.918zm29.997 4.214a8.266 8.266 0 0 0-2.907-1.493 12.199 12.199 0 0 0-3.273-.428c-1.282 0-2.49.244-3.622.736a9.21 9.21 0 0 0-2.945 2.004c-.833.847-1.496 1.842-1.986 2.989s-.736 2.358-.736 3.642c0 1.282.246 2.496.736 3.64a9.558 9.558 0 0 0 1.986 2.99 9.211 9.211 0 0 0 2.945 2.002c1.132.493 2.34.74 3.622.74.49 0 1.03-.036 1.616-.103.587-.068 1.208-.205 1.863-.41s1.314-.49 1.985-.86a9.141 9.141 0 0 0 1.9-1.411l1.353 1.8a8.878 8.878 0 0 1-3.828 2.6c-1.513.53-3.13.797-4.848.797-1.637 0-3.18-.313-4.625-.941a12.267 12.267 0 0 1-3.784-2.537c-1.08-1.065-1.93-2.32-2.558-3.766s-.941-2.986-.941-4.623.314-3.18.941-4.625c.628-1.446 1.473-2.702 2.537-3.763a12.094 12.094 0 0 1 3.764-2.54 11.541 11.541 0 0 1 4.625-.939c1.39 0 2.775.252 4.153.757 1.379.504 2.584 1.164 3.622 1.983l-1.595 1.76z" class="st0" data-v-148c7c28=""></path></g> <g id="logo_23_" data-v-148c7c28=""><path id="_x3C_Compound_Path_x3E__44_" d="M29.41 1.556c-.032-.052-.116-.052-.147 0L20.34 17.013a.645.645 0 0 0-.499 0l-2.156-3.733c-.03-.053-.114-.053-.144 0l-7.11 12.315a.647.647 0 0 0-.25-.05.636.636 0 0 0-.389.142l-8.134-8.134a.084.084 0 0 0-.132.102l6.745 11.681-6.744 11.681a.08.08 0 0 0 0 .084.082.082 0 0 0 .072.042h13.488l2.454 4.25a.083.083 0 0 0 .072.041c.01 0 .022-.002.032-.006a.084.084 0 0 0 .05-.099l-1.123-4.186h16.422c.032.233.176.43.386.516l-4.125 15.393c-.01.04.01.083.049.1.01.003.022.005.032.005a.086.086 0 0 0 .073-.041l16.015-27.738a.087.087 0 0 0 0-.084L29.409 1.556zm4.606 38.996a.636.636 0 0 0-.389-.142.645.645 0 0 0-.249.05l-6.13-10.618a.632.632 0 0 0 .244-.422h17.656L34.016 40.552zm-20.061-11.3a.633.633 0 0 0-.244-.423l6.13-10.617a.644.644 0 0 0 .5 0l6.13 10.617a.633.633 0 0 0-.245.423H13.955zm-3.774-2.408c.149 0 .279-.058.389-.142l2.245 2.245a.636.636 0 0 0-.143.389c0 .359.291.65.65.65.03 0 .054-.013.083-.017l2.95 11.007h-1.17l-6.72-11.64 1.466-2.542c.077.032.161.05.25.05zM29.336 1.765l15.87 27.487H27.492a.642.642 0 0 0-.882-.516L20.48 18.12a.638.638 0 0 0 .26-.506.638.638 0 0 0-.26-.507l8.856-15.34zM17.613 13.49l2.089 3.617a.638.638 0 0 0-.261.507c0 .21.106.388.26.506l-6.13 10.618a.646.646 0 0 0-.249-.05.636.636 0 0 0-.389.142l-2.245-2.246a.636.636 0 0 0 .142-.388.638.638 0 0 0-.26-.507l7.043-12.2zM1.989 18.12l7.685 7.685a.636.636 0 0 0-.143.389c0 .21.106.388.26.507l-1.423 2.467L1.989 18.12zm-.245 22.855l6.623-11.473 6.624 11.473H1.744zm15.624 3.781l-2.087-3.614h1.118l.969 3.614zm-3.8-14.821a.643.643 0 0 0 .387-.516h12.271a.642.642 0 0 0 .883.515l6.13 10.617a.633.633 0 0 0-.245.424H16.528l-2.96-11.04zm16.014 26.546l3.963-14.79c.028.004.053.017.082.017a.65.65 0 0 0 .65-.65.636.636 0 0 0-.143-.388L44.96 29.845 29.582 56.482z" class="st0" data-v-148c7c28=""></path> <path id="_x3C_Compound_Path_x3E__43_" d="M45.538 29.227L30.303 2.84c.375-.293.632-.729.632-1.241a1.599 1.599 0 1 0-3.198 0c0 .213.046.416.122.602L2.84 16.646c-.293-.375-.728-.632-1.241-.632a1.599 1.599 0 1 0 0 3.198c.214 0 .416-.046.603-.122l5.915 10.246-5.915 10.246a1.59 1.59 0 0 0-.603-.122 1.599 1.599 0 1 0 0 3.198c.513 0 .948-.257 1.241-.632L27.859 56.47a1.59 1.59 0 0 0 1.477 2.201c.883 0 1.6-.716 1.6-1.599 0-.512-.258-.948-.633-1.24l15.235-26.388a.22.22 0 0 0 0-.218zM13.711 47.803L3.132 41.694l14.37 3.85 10.516 10.518-14.307-8.26zM8.367 29.769l8.797 15.237-11.925-3.195-2.08-.558c.008-.066.039-.125.039-.194 0-.512-.257-.948-.632-1.24l4.806-8.325.995-1.725zm20.97 25.706c-.363 0-.681.142-.95.345L17.919 45.35l26.906-15.533-14.884 25.78a1.588 1.588 0 0 0-.604-.122zM13.71 10.869L28.018 2.61 17.5 13.128l-14.37 3.85 10.58-6.109zM3.198 17.613c0-.069-.031-.128-.04-.194L17.67 13.53a.21.21 0 0 0 .097-.056L28.388 2.852c.268.203.586.345.948.345.214 0 .417-.045.604-.121l15.147 26.236L17.724 45.11l-9.17-15.883-5.988-10.373c.375-.293.632-.729.632-1.241z" class="st0" data-v-148c7c28=""></path> <path id="_x3C_Compound_Path_x3E__42_" d="M45.35 25.921c-1.074 0-2.02.506-2.646 1.282L20.79 14.551c.148-.382.238-.794.238-1.23a3.415 3.415 0 0 0-6.83 0 3.406 3.406 0 0 0 2.891 3.363v25.304a3.406 3.406 0 0 0-2.89 3.362 3.415 3.415 0 1 0 6.829 0c0-.435-.09-.847-.238-1.229l21.914-12.652a3.393 3.393 0 0 0 2.646 1.282 3.415 3.415 0 0 0 0-6.83zM18.137 41.988V16.684a3.39 3.39 0 0 0 2.123-1.23l21.913 12.653c-.148.382-.237.794-.237 1.229s.089.847.237 1.23L20.26 43.218a3.39 3.39 0 0 0-2.123-1.23z" class="st0" data-v-148c7c28=""></path></g></g></g></svg>

Then run this
javascript:(function() {  var buttons = document.querySelectorAll('button');  buttons.forEach(function(button) {    if (button.innerText === 'Follow') {      button.click();    }  });})();

Then click this
<a href="/discover" data-v-3d9a46ef="" class="">
            Discover
          </a>

Then repeat X times.
Space bar should interupt

---

## Assistant

To achieve the sequence of actions you described using Hammerspoon, we can set up a script that combines both clicking on SVG elements and executing JavaScript in Chrome. Additionally, we'll incorporate a hotkey (spacebar) to interrupt the script. Here's how you can set it up:

### Step 1: Install Hammerspoon
Make sure Hammerspoon is installed on your Mac.

### Step 2: Write the Hammerspoon Script

Open your `init.lua` file in Hammerspoon's configuration directory and add the following code:

```lua
-- Define a variable to stop the script
local shouldStop = false

-- Function to stop the script when the spacebar is pressed
hs.hotkey.bind({}, "space", function()
    shouldStop = true
    hs.alert.show("Script Interrupted")
end)

-- Function to click on the SVG element
local function clickSVG()
    local appleScript = [[
    tell application "Google Chrome"
        execute front window's active tab javascript "document.querySelector('svg.logo.logo-desktop').parentNode.click();"
    end tell
    ]]
    hs.osascript.applescript(appleScript)
end

-- Function to run JavaScript for clicking "Follow" buttons
local function clickFollowButton()
    local appleScript = [[
    tell application "Google Chrome"
        execute front window's active tab javascript "var buttons = document.querySelectorAll('button'); buttons.forEach(function(button) { if (button.innerText === 'Follow') { button.click(); } });"
    end tell
    ]]
    hs.osascript.applescript(appleScript)
end

-- Function to click on the "Discover" link
local function clickDiscover()
    local appleScript = [[
    tell application "Google Chrome"
        execute front window's active tab javascript "document.querySelector('a[href=\"/discover\"]').click();"
    end tell
    ]]
    hs.osascript.applescript(appleScript)
end

-- Function to perform the sequence
local function performSequence(repeatCount)
    for i = 1, repeatCount do
        if shouldStop then break end
        clickSVG()
        hs.timer.usleep(1000000) -- Wait 1 second
        clickFollowButton()
        hs.timer.usleep(1000000) -- Wait 1 second
        clickDiscover()
        hs.timer.usleep(1000000) -- Wait 1 second
    end
end

-- Set the number of times to repeat the sequence
local repeatCount = 10

-- Run the sequence
performSequence(repeatCount)
```

### Step 3: Save and Reload Hammerspoon
- Save the `init.lua` file.
- Reload your Hammerspoon configuration by clicking the Hammerspoon icon in the menu bar and selecting "Reload Config."

### Step 4: Running and Stopping the Script
- The script will automatically run and start clicking the elements in the specified order.
- If you need to stop the script at any time, press the **spacebar**.

### Key Points:
1. **SVG Click**: The script clicks the SVG element you mentioned by selecting it based on its class.
2. **Follow Button Click**: The script clicks all buttons with the text "Follow."
3. **Discover Link Click**: The script clicks the "Discover" link based on the `href` attribute.
4. **Interrupting**: Pressing the spacebar will stop the script immediately.

This setup allows you to automate the sequence of actions in Chrome as described.

---

## User

letsdoitwithUI vision

---

## Assistant

To achieve the task using **UI.Vision RPA** (a popular browser automation tool), here's a step-by-step guide:

### Step 1: Install UI.Vision RPA
1. **Install UI.Vision RPA**:
   - Visit the [UI.Vision RPA](https://ui.vision/rpa) website.
   - Install the extension for your browser (Chrome or Firefox).

### Step 2: Create a New Macro in UI.Vision RPA

1. **Open UI.Vision RPA**:
   - Click on the UI.Vision icon in your browser's toolbar to open the RPA interface.

2. **Create a New Macro**:
   - Click the **+** button to create a new macro.
   - Name your macro something descriptive, like `ClickSequence`.

### Step 3: Automate the Steps

1. **Step 1: Click on the SVG Element**:
   - Use the `Click` command to interact with the SVG element.
   - You may need to use the `XClick` command if the SVG cannot be easily selected via CSS selectors.

   Example:
   ```plaintext
   Command: XClick
   Target: "image_of_SVG_element.png"
   ```

   - Capture an image of the SVG element using UI.Vision's screenshot feature and use it as the target.

2. **Step 2: Run JavaScript to Click "Follow" Buttons**:
   - Use the `ExecuteScript` command to run your JavaScript for clicking the "Follow" buttons.

   Example:
   ```plaintext
   Command: ExecuteScript
   Target: javascript:(function() {  var buttons = document.querySelectorAll('button');  buttons.forEach(function(button) {    if (button.innerText === 'Follow') {      button.click();    }  });})()
   ```

3. **Step 3: Click on the "Discover" Link**:
   - Use the `Click` command again to click the "Discover" link. You can use the selector or image recognition to target the link.

   Example:
   ```plaintext
   Command: Click
   Target: "css=a[href='/discover']"
   ```

   Or, if you prefer using image recognition:
   ```plaintext
   Command: XClick
   Target: "image_of_discover_link.png"
   ```

### Step 4: Loop the Sequence

1. **Repeat the Sequence X Times**:
   - Use the `Times` or `While` loop commands to repeat the sequence of actions a specific number of times.

   Example:
   ```plaintext
   Command: Times
   Target: X
   ```

   Replace `X` with the number of times you want the sequence to repeat.

### Step 5: Add an Interruption Hotkey

1. **Use UI.Vision's Built-in Hotkey Feature**:
   - Go to the UI.Vision RPA settings.
   - Set up a hotkey (e.g., the spacebar) to stop the macro.

### Step 6: Save and Run the Macro

1. **Save the Macro**:
   - Save your macro after setting it up.
   - You can run the macro directly from the UI.Vision interface or assign it a hotkey for quick access.

2. **Test and Adjust**:
   - Run the macro to see if it clicks the elements as expected.
   - Adjust the timings, selectors, or screenshots if necessary.

### Final Notes:

- **Image Recognition**: UI.Vision’s `XClick` command is handy when dealing with elements that are hard to select via standard CSS selectors, especially for graphical elements like SVGs.
- **JavaScript Execution**: The `ExecuteScript` command allows you to run custom JavaScript, which is useful for tasks like clicking buttons with specific text.
- **Hotkey**: Setting a hotkey to stop the macro ensures you can interrupt the automation anytime if needed.

By following these steps, you should be able to automate the process of clicking on an SVG element, running JavaScript to click "Follow" buttons, clicking a link, and repeating the sequence multiple times using UI.Vision RPA.


## See Also
- [[chatgpt/chatgpt_automating-browser-clicks]]
- [[chatgpt/chatgpt_adjust-off-screen-menu]]
- [[chatgpt/chatgpt_black-screen-youtube-fix]]
- [[chatgpt/chatgpt_drag-and-drop-screen-design]]
- [[chatgpt/chatgpt_fix-loading-screen-design]]

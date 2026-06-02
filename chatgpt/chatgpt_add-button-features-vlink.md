---
title: "Add Button Features VLink"
type: note
created: 2024-06-27
updated: 2024-06-27
source: chatgpt-export
conversation_id: 4ed8f284-79bb-42a7-8ce7-0b53dc54d3bc
message_count: 2
tags: [chatgpt, import, code]
---
# Add Button Features VLink

> Conversation ID: 4ed8f284-79bb-42a7-8ce7-0b53dc54d3bc
> Created: 2024-06-27T02:05:27Z
> Updated: 2024-06-27T02:05:48Z
> Messages: 2

---

## User

Okay, so I just sent my Linktree competitor product demo to Mackenzie, and Mackenzie had the following feedback. First, I need to include a email button of some kind. Second, I should deep link to the Reels and YouTube Shorts pages for the Instagram and YouTube buttons. Third, the OnlyFans logo should change to the Spicy Emoji. And I believe that's it. And then my note is that for the Spicy Emoji button, I probably want to write a tag on that so that search engines do not follow that. We want to block Instagram from crawling it so that Instagram does not blacklist VLink and BioLink.

---

## Assistant

Great! Here are the steps to implement Mackenzie's feedback and your note for your Linktree competitor product demo:

1. **Email Button:**
   - Add an email button to the UI. Ensure it opens the default mail client with a mailto link when clicked.
   ```html
   <a href="mailto:your-email@example.com" class="btn-email">Email Me</a>
   ```

2. **Deep Linking to Reels and YouTube Shorts:**
   - Update the Instagram and YouTube buttons to deep link directly to Reels and YouTube Shorts pages.
   ```html
   <!-- Instagram Reels Link -->
   <a href="https://www.instagram.com/reels/" class="btn-instagram">Instagram Reels</a>
   <!-- YouTube Shorts Link -->
   <a href="https://www.youtube.com/shorts/" class="btn-youtube">YouTube Shorts</a>
   ```

3. **Change OnlyFans Logo to Spicy Emoji:**
   - Update the OnlyFans button to use a Spicy Emoji. You can use an image or an emoji directly.
   ```html
   <a href="https://onlyfans.com/your-profile" class="btn-onlyfans">🌶️</a>
   ```

4. **Block Search Engines from Crawling Spicy Emoji Button:**
   - Add a `rel="nofollow"` attribute to the Spicy Emoji button to prevent search engines from following the link.
   ```html
   <a href="https://onlyfans.com/your-profile" class="btn-onlyfans" rel="nofollow">🌶️</a>
   ```

5. **Ensure Instagram Does Not Crawl:**
   - To prevent Instagram from crawling the Spicy Emoji button and potentially blacklisting your platform, ensure the link is correctly marked as nofollow.
   ```html
   <a href="https://onlyfans.com/your-profile" class="btn-onlyfans" rel="nofollow">🌶️</a>
   ```

Here’s a consolidated example of how the HTML might look:
```html
<div class="link-buttons">
   <a href="mailto:your-email@example.com" class="btn-email">Email Me</a>
   <a href="https://www.instagram.com/reels/" class="btn-instagram">Instagram Reels</a>
   <a href="https://www.youtube.com/shorts/" class="btn-youtube">YouTube Shorts</a>
   <a href="https://onlyfans.com/your-profile" class="btn-onlyfans" rel="nofollow">🌶️</a>
</div>
```

Make sure to test all changes to ensure they function as expected. Let me know if you need any further assistance!

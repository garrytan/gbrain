---
title: "Creating Google Web Stories"
type: guide
created: 2024-06-27
updated: 2024-06-27
source: chatgpt-export
conversation_id: 7edc69b7-7ae1-4744-be4d-62f7e804ede4
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Creating Google Web Stories

> Conversation ID: 7edc69b7-7ae1-4744-be4d-62f7e804ede4
> Created: 2024-06-27T21:03:32Z
> Updated: 2024-06-27T22:51:13Z
> Messages: 6

---

## User

Can you tell me, from a technical aspect, how Google Web Stories work? I mean, if I were to try and create a Web Story, what am I actually creating? Is it like a piece of code? What does that code look like?

---

## Assistant

Google Web Stories are a type of web content that provide a visual and interactive way to present information. They are built using AMP (Accelerated Mobile Pages) technology. If you want to create a Web Story, you are essentially creating a piece of HTML code that follows specific AMP components and guidelines. Here’s an overview of how Web Stories work and what the code looks like:

### Key Components of a Web Story

1. **HTML Structure**: A Web Story is structured using HTML with AMP-specific tags.
2. **AMP Story Component**: The core component of a Web Story is `<amp-story>`, which encapsulates the entire story.
3. **Pages and Layers**: Each story consists of multiple `<amp-story-page>` elements, and each page can have multiple layers, defined by `<amp-story-grid-layer>`.
4. **Media**: You can include images, videos, and text within these layers.

### Basic Structure

Here’s a simple example of what the code for a Web Story looks like:

```html
<!doctype html>
<html ⚡>
<head>
  <meta charset="utf-8">
  <title>My Web Story</title>
  <link rel="canonical" href="self.html">
  <meta name="viewport" content="width=device-width,minimum-scale=1,initial-scale=1">
  <style amp-custom>
    /* Custom styles here */
  </style>
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <script async custom-element="amp-story" src="https://cdn.ampproject.org/v0/amp-story-1.0.js"></script>
</head>
<body>
  <amp-story standalone
    title="My Web Story"
    publisher="Publisher Name"
    publisher-logo-src="https://example.com/logo.png"
    poster-portrait-src="https://example.com/poster.jpg">

    <!-- Page 1 -->
    <amp-story-page id="page1">
      <amp-story-grid-layer template="fill">
        <amp-img src="https://example.com/image1.jpg" width="720" height="1280" layout="responsive"></amp-img>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="vertical">
        <h1>Page 1 Title</h1>
        <p>This is the text on page 1.</p>
      </amp-story-grid-layer>
    </amp-story-page>

    <!-- Page 2 -->
    <amp-story-page id="page2">
      <amp-story-grid-layer template="fill">
        <amp-img src="https://example.com/image2.jpg" width="720" height="1280" layout="responsive"></amp-img>
      </amp-story-grid-layer>
      <amp-story-grid-layer template="vertical">
        <h1>Page 2 Title</h1>
        <p>This is the text on page 2.</p>
      </amp-story-grid-layer>
    </amp-story-page>

  </amp-story>
</body>
</html>
```

### Key Elements

1. **`<amp-story>`**: The container for the entire story.
2. **`<amp-story-page>`**: Defines a single page within the story.
3. **`<amp-story-grid-layer>`**: Defines a layout grid for arranging elements on the page.
4. **Media Elements**: Such as `<amp-img>` for images and `<amp-video>` for videos.

### AMP-Specific Tags and Scripts

- **AMP scripts**: `<script async src="https://cdn.ampproject.org/v0.js"></script>` and `<script async custom-element="amp-story" src="https://cdn.ampproject.org/v0/amp-story-1.0.js"></script>` are required to load AMP and the story component.
- **AMP Boilerplate**: Ensures the page is AMP-compliant and handles initial loading styles.

### Creating and Publishing

1. **Create the HTML file**: Write the HTML code as shown above.
2. **Validate**: Use the [AMP Validator](https://validator.ampproject.org/) to ensure your story is AMP-compliant.
3. **Publish**: Upload your Web Story to your web server.

### Tools and Editors

You can use various tools to create Web Stories more easily:
- **Google’s Web Stories for WordPress Plugin**: Simplifies the creation process for WordPress users.
- **AMP Stories editor**: Visual editors like MakeStories or Newsroom Studio can help create stories without manually writing code.

Creating a Google Web Story involves writing AMP-specific HTML that organizes your content into a visually engaging format. The example provided gives a basic template that you can expand with more pages, media, and interactivity.

---

## User

And then, what is the advantage to me making this content? Like, where does it become discoverable?

---

## Assistant

Creating Google Web Stories offers several advantages, primarily centered around discoverability, user engagement, and performance. Here’s how creating Web Stories can benefit you:

### Advantages of Creating Google Web Stories

1. **Enhanced Discoverability**:
   - **Google Search**: Web Stories can appear in Google Search results, including the mobile web carousel. This can significantly boost your content's visibility.
   - **Google Discover**: Web Stories are prominently featured in Google Discover, which can drive a large amount of traffic to your content.
   - **Google Images**: Web Stories can also show up in Google Images, further increasing their reach.

2. **User Engagement**:
   - **Visual and Interactive**: Web Stories are visually appealing and interactive, making them more engaging than traditional text-based content.
   - **Mobile-First Experience**: They are designed for mobile devices, providing a smooth and immersive experience for users on smartphones and tablets.
   - **Storytelling Format**: The format encourages a narrative style, which can help retain user attention and encourage them to consume more of your content.

3. **Performance**:
   - **Fast Loading**: Built on AMP technology, Web Stories load quickly, reducing bounce rates and improving user experience.
   - **SEO Benefits**: Google prioritizes fast, mobile-friendly content, so Web Stories can improve your site’s overall SEO performance.

4. **Monetization**:
   - **Ad Integration**: You can integrate ads into Web Stories, offering a new revenue stream.
   - **Affiliate Links**: Stories can include affiliate links, driving additional income through commissions.

### Discoverability

1. **Google Search**:
   - Web Stories can appear as rich results, often in a carousel format, especially on mobile devices.
   - They can also show up in regular search results with a distinct thumbnail and visual indicator.

2. **Google Discover**:
   - Featured prominently in Google Discover feeds, Web Stories can attract users who are browsing for new and interesting content.

3. **Google Images**:
   - Stories can appear in Google Images search results, providing another avenue for discovery.

4. **Social Media and Embedding**:
   - Web Stories can be shared on social media platforms, increasing their reach.
   - They can be embedded on your website or blog, providing an engaging content format for your visitors.

### Practical Impact

1. **Increased Traffic**: By appearing in various Google properties, Web Stories can drive substantial traffic to your site.
2. **Brand Awareness**: The visual and engaging nature of Web Stories can help build brand awareness and recognition.
3. **Audience Retention**: The immersive experience of Web Stories can keep users on your site longer, reducing bounce rates and increasing the likelihood of conversions.

### Summary

Creating Google Web Stories allows you to tap into a highly engaging content format that is well-supported by Google’s ecosystem. This can lead to increased visibility, higher engagement rates, and additional revenue opportunities, making it a valuable addition to your content strategy.

---

## User

Can you find me a video of Apple's device that tests the MacBooks, the one that like twists them?

---

## Assistant

I couldn't find a specific video showing the Apple device that performs the twisting test on MacBooks, but I can provide you with some context and information about Apple's stress testing procedures.

Apple conducts rigorous stress tests on their MacBook models, including tests for durability, flexibility, and overall resilience. These tests include subjecting the devices to various forms of mechanical stress, such as twisting, bending, and pressure tests. The objective is to ensure that the devices can withstand everyday use and potential accidents without compromising their structural integrity.

The twisting test, in particular, involves using specialized machinery to apply torsional forces to the MacBook's chassis. This helps Apple identify weak points and improve the overall build quality of their devices.

If you want to see some of these testing processes, Apple's [official YouTube channel](https://www.youtube.com/user/Apple) and other tech review channels occasionally provide behind-the-scenes looks at their testing labs during product launches and special events.

For more detailed insights, websites like MacRumors and AppleInsider often discuss Apple's testing methodologies in their reviews and articles on new MacBook models. These sources provide comprehensive reviews and sometimes include information about the durability tests performed by Apple【17†source】【18†source】【19†source】【20†source】.

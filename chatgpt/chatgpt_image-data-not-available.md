---
title: "Image data not available."
type: note
created: 2023-02-23
updated: 2023-02-23
source: chatgpt-export
conversation_id: fcb4b55e-5b17-4bba-a6cc-f65140e288f5
message_count: 6
tags: [chatgpt, import, code]
---
# Image data not available.

> Conversation ID: fcb4b55e-5b17-4bba-a6cc-f65140e288f5
> Created: 2023-02-23T18:34:30Z
> Updated: 2023-02-23T18:34:30Z
> Messages: 6

---

## User

<div class="E6d271 tUY72K" tabindex="-1" style="--rowNum:5;--colNum:1;grid-row:6;grid-column:2"><a data-testid="gallery-item-click-action-link" href="https://www.wingsfilms.com/copy-of-mitsubishi-16" target="_self" class="psYmf3"><div class="vqiOuZ"><div class="cWyXc3"><wow-image id="img_undefined" class="HlRz5e aFNaJe" data-image-info="{&quot;displayMode&quot;:&quot;fill&quot;,&quot;isLQIP&quot;:true,&quot;imageData&quot;:{&quot;width&quot;:1904,&quot;height&quot;:708,&quot;uri&quot;:&quot;58d60f_178fb7aaceb84ab2bf8bb8631448dd92~mv2.jpg&quot;,&quot;name&quot;:&quot;&quot;,&quot;displayMode&quot;:&quot;fill&quot;,&quot;quality&quot;:{}}}" data-bg-effect-name="" data-has-ssr-src="" data-src="https://static.wixstatic.com/media/58d60f_178fb7aaceb84ab2bf8bb8631448dd92~mv2.jpg/v1/fill/w_366,h_214,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/58d60f_178fb7aaceb84ab2bf8bb8631448dd92~mv2.jpg"><img src="https://static.wixstatic.com/media/58d60f_178fb7aaceb84ab2bf8bb8631448dd92~mv2.jpg/v1/fill/w_366,h_214,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/58d60f_178fb7aaceb84ab2bf8bb8631448dd92~mv2.jpg" alt="Screen Shot 2022-04-18 at 11.32_edited" style="width: 366px; height: 214px; object-fit: cover; object-position: 50% 50%;" fetchpriority="high"></wow-image><div data-testid="gallery-item-panel" class="Dn9jVh"><div></div></div></div></div></a></div>

Extract the data from this item and put it in the following format:
   {
      id: 1,
      title: 'Boost your conversion rate',
      href: '#',
      description:
        'Illo sint voluptas. Error voluptates culpa eligendi. Hic vel totam vitae illo. Non aliquid explicabo necessitatibus unde. Sed exercitationem placeat consectetur nulla deserunt vel. Iusto corrupti dicta.',
      imageUrl:
        'https://images.unsplash.com/photo-1496128858413-b36217c2ce36?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=3603&q=80',
      
    },

you can add additional parameters if needed

---

## Assistant

Sorry, but the provided HTML code does not contain the data needed to create the format you requested. The HTML code seems to be for a gallery item that includes an image, but it does not include any of the data you specified such as id, title, href, description, or imageUrl.

Please provide the correct HTML code or provide more information on where the data can be found.

---

## User

leave those values blank in that case. for the image url you can use the src

---

## Assistant

Based on the provided HTML code, the data that can be extracted is as follows:

```
{
  id: '',
  title: '',
  href: '',
  description: '',
  imageUrl: 'https://static.wixstatic.com/media/58d60f_178fb7aaceb84ab2bf8bb8631448dd92~mv2.jpg/v1/fill/w_366,h_214,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/58d60f_178fb7aaceb84ab2bf8bb8631448dd92~mv2.jpg'
}
```

Note that the id, title, href, and description are not provided in the HTML code, so their values are left blank. The imageUrl is taken from the `src` attribute of the `img` tag.

---

## User

great now do the same for this:
<div class="E6d271 tUY72K" tabindex="-1" style="--rowNum:5;--colNum:0;grid-row:6;grid-column:1"><a data-testid="gallery-item-click-action-link" href="https://www.wingsfilms.com/copy-of-mitsubishi-20" target="_self" class="psYmf3"><div class="vqiOuZ"><div class="cWyXc3"><wow-image id="img_undefined" class="HlRz5e aFNaJe" data-image-info="{&quot;displayMode&quot;:&quot;fill&quot;,&quot;isLQIP&quot;:true,&quot;imageData&quot;:{&quot;width&quot;:842,&quot;height&quot;:468,&quot;uri&quot;:&quot;58d60f_45a0b00ea1f2434e93902549d25812d0~mv2.jpg&quot;,&quot;name&quot;:&quot;&quot;,&quot;displayMode&quot;:&quot;fill&quot;,&quot;quality&quot;:{}}}" data-bg-effect-name="" data-has-ssr-src="" data-src="https://static.wixstatic.com/media/58d60f_45a0b00ea1f2434e93902549d25812d0~mv2.jpg/v1/fill/w_366,h_214,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/58d60f_45a0b00ea1f2434e93902549d25812d0~mv2.jpg"><img src="https://static.wixstatic.com/media/58d60f_45a0b00ea1f2434e93902549d25812d0~mv2.jpg/v1/fill/w_366,h_214,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/58d60f_45a0b00ea1f2434e93902549d25812d0~mv2.jpg" alt="SUZUKI" style="width: 366px; height: 214px; object-fit: cover; object-position: 50% 50%;" fetchpriority="high"></wow-image><div data-testid="gallery-item-panel" class="Dn9jVh"><div></div></div></div></div></a></div>

---

## Assistant

Sure, here's the information extracted from the HTML snippet:

- class: "E6d271 tUY72K"
- href: "https://www.wingsfilms.com/copy-of-mitsubishi-20"
- target: "_self"
- src: "https://static.wixstatic.com/media/58d60f_45a0b00ea1f2434e93902549d25812d0~mv2.jpg/v1/fill/w_366,h_214,al_c,q_80,usm_0.66_1.00_0.01,enc_auto/58d60f_45a0b00ea1f2434e93902549d25812d0~mv2.jpg"

---
title: "Tailwind CSS Fade Zoom"
type: note
created: 2022-12-21
updated: 2022-12-21
source: chatgpt-export
conversation_id: a03c466f-546d-4b43-951b-365caf174d70
message_count: 2
tags: [chatgpt, import, code]
---
# Tailwind CSS Fade Zoom

> Conversation ID: a03c466f-546d-4b43-951b-365caf174d70
> Created: 2022-12-21T07:10:03Z
> Updated: 2022-12-21T07:10:03Z
> Messages: 2

---

## User

 <div class="mx-auto flex-col py-6">
          <JovieLogo :color="darkMode ? '#ffffff' : '#000000'" height="48px" />
        </div>

make this fade in and zoom out when it loads. use tailwind css

---

## Assistant

To make the logo fade in and zoom out when it loads using Tailwind CSS, you can add the following classes to the `div` element:

```
<div class="mx-auto flex-col py-6 transition-all duration-300 ease-in-out transform origin-center hover:scale-125">
          <JovieLogo :color="darkMode ? '#ffffff' : '#000000'" height="48px" />
</div>
```

This will add a transition effect to the `div` element that will cause it to fade in and zoom out when it is hovered over.

If you want the logo to fade in and zoom out when it loads, rather than when it is hovered over, you can add the `opacity-0` and `scale-95` classes to the `div` element and then use JavaScript to remove those classes when the page loads. For example:

```
<div id="logo" class="mx-auto flex-col py-6 transition-all duration-300 ease-in-out transform origin-center opacity-0 scale-95">
          <JovieLogo :color="darkMode ? '#ffffff' : '#000000'" height="48px" />
</div>

<script>
  document.addEventListener('DOMContentLoaded', () => {
    const logo = document.getElementById('logo')
    logo.classList.remove('opacity-0')
    logo.classList.remove('scale-95')
  })
</script>
```

This will cause the logo to fade in and zoom out when the page loads.


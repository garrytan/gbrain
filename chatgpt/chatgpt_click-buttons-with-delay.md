---
title: "Click Buttons with Delay"
type: essay
created: 2024-05-23
updated: 2024-05-23
source: chatgpt-export
conversation_id: 9cad3e68-676a-4012-a447-7716858fcf02
message_count: 24
tags: [chatgpt, import, code, long-form]
---
# Click Buttons with Delay

> Conversation ID: 9cad3e68-676a-4012-a447-7716858fcf02
> Created: 2024-05-23T21:57:01Z
> Updated: 2024-05-23T22:13:33Z
> Messages: 24

---

## User

write a script i can paste in inspector to click all buttons with class
_user_11o7n_1 _notLastUser_11o7n_14

add a 100ms delay

---

## Assistant

Here's a script you can paste into the browser console to click all buttons with the specified classes, adding a 100ms delay between each click:

```javascript
const buttons = document.querySelectorAll('._user_11o7n_1._notLastUser_11o7n_14');
let delay = 100;

buttons.forEach((button, index) => {
  setTimeout(() => {
    button.click();
  }, delay * index);
});
```

This script selects all buttons with the classes `_user_11o7n_1` and `_notLastUser_11o7n_14`, and clicks them with a 100ms delay between each click.

---

## User

actually should click all harmony-7dahz9

---

## Assistant

Here is the updated script to click all elements with the class `harmony-7dahz9` with a 100ms delay between each click:

```javascript
const buttons = document.querySelectorAll('.harmony-7dahz9');
let delay = 100;

buttons.forEach((button, index) => {
  setTimeout(() => {
    button.click();
  }, delay * index);
});
```

This script selects all elements with the class `harmony-7dahz9` and clicks them with a 100ms delay between each click.

---

## User

should then scroll and then repeat

---

## Assistant

Here's an updated script that will click all elements with the class `harmony-7dahz9`, scroll down, and then repeat the process. This will continue until no more elements with the specified class are found:

```javascript
function clickButtonsAndScroll() {
  const buttons = document.querySelectorAll('.harmony-7dahz9');
  let delay = 100;

  if (buttons.length === 0) {
    console.log('No more buttons to click.');
    return;
  }

  buttons.forEach((button, index) => {
    setTimeout(() => {
      button.click();
    }, delay * index);
  });

  // Wait for all clicks to complete before scrolling and repeating
  setTimeout(() => {
    window.scrollBy(0, window.innerHeight);
    setTimeout(clickButtonsAndScroll, 2000); // Wait 2 seconds before repeating
  }, delay * buttons.length);
}

clickButtonsAndScroll();
```

This script will:
1. Click all elements with the class `harmony-7dahz9` with a 100ms delay between each click.
2. Scroll down by one viewport height.
3. Wait 2 seconds and repeat the process until no more elements with the specified class are found.

---

## User

scrolling is contained within this modal

<div class="Modal-module_body__efFIt Modal-module_noScroll__2JBY9 _modalBody_6fj4f_1" role="dialog" aria-labelledby="modal-11-title" aria-describedby="modal-11-subtitle" style="transform: scale(1); opacity: 1; margin-top: 0px; padding-left: 0px; padding-right: 0px;"><div class="Modal-module_headerContainer__R1D5r _modalHeader_6fj4f_8"><div class="Modal-module_dismissButton__6ofky"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" class="css-152sgt4" aria-hidden="true" fillColor="#C2C0CC"><path fill="#C2C0CC" fill-rule="evenodd" d="M5.866 2.49 12 8.622l6.134-6.132a1.672 1.672 0 0 1 2.364 0l1.012 1.012a1.672 1.672 0 0 1 0 2.364L15.378 12l6.132 6.134a1.672 1.672 0 0 1 0 2.364l-1.012 1.012a1.672 1.672 0 0 1-2.364 0L12 15.378 5.866 21.51a1.672 1.672 0 0 1-2.364 0L2.49 20.498a1.672 1.672 0 0 1 0-2.364L8.622 12 2.49 5.866a1.672 1.672 0 0 1 0-2.364L3.502 2.49a1.672 1.672 0 0 1 2.364 0Z" clip-rule="evenodd"></path></svg></div><div id="modal-11-title" class="Modal-module_header__oNRKC _modalTitle_6fj4f_13"><div class="_titleContainer_6fj4f_21"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_6fj4f_26" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span>Followers</span></div></div><div id="modal-11-subtitle" class="Modal-module_subtitle__4um5e"></div></div><div id=":rb:" class="scrollbar-container Scrollbar-module_scrollbar__S-zEj _scrollable_6fj4f_36 ps ps--active-y"><div><div class="_content_11o7n_18"><div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 2; background-color: unset; background-image: url(&quot;https://audius-cn1.tikilabs.com/content/01HF7FEBEMY9ZEV98EHQJ5EFWR/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 1; background-color: unset;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Audius</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,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"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@Audius</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">1.7M</span><span>Followers</span></div><div class="_badge_1fx8m_1 _list_1fx8m_18 _followsYou_1v5na_105">Follows You</div></div></div></div><button class="harmony-1gkzsw0"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-16b6yvb" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M21.63 12.722a1.184 1.184 0 0 1 .114 1.595l-4.383 5.53a1.07 1.07 0 0 1-.822.414c-.332 0-.628-.14-.835-.386l-2.124-2.513a1.178 1.178 0 0 1-.275-.81c.012-.29.129-.574.342-.785a1.058 1.058 0 0 1 1.568.074l1.28 1.515 3.568-4.503a1.058 1.058 0 0 1 1.568-.132Zm-15.764-.313a6.06 6.06 0 0 0 3.96 1.465c.886 0 1.727-.19 2.486-.53-1.018 2.09-1.023 4.894.16 6.783C7.917 20.606 2 19.802 2 17.714c0-2.26 1.553-4.236 3.866-5.305Zm3.96-8.67a4.348 4.348 0 1 1 0 8.696 4.348 4.348 0 0 1 0-8.696Z" clip-rule="evenodd"></path></svg><span class="harmony-qna1j2">Following</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 2; background-color: unset; background-image: url(&quot;https://audius-creator-4.theblueprint.xyz/content/01H5K1HVF6S09PHSCDSHTPJ26E/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 1; background-color: unset;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Disclosure</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,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"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@disclosure</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">214K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 2; background-color: unset; background-image: url(&quot;https://audius-content-10.cultur3stake.com/content/QmbqvqeywxBSDawE1jrZiHVmyMkCig5BRKTswahCfYpKPs/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 1; background-color: unset;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Cheat Codes</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,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"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@CheatCodesMusic</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">118K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 2; background-color: unset; background-image: url(&quot;https://blockchange-audius-content-02.bdnodes.net/content/QmTYqsfLtD8NDziWYMYJKRkf13MmJJU5oBdn4aTm3tKLiG/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 1; background-color: unset;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>HasenChat Music</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,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"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@hasenchat</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">56.6K</span><span>Followers</span></div><div class="_badge_1fx8m_1 _list_1fx8m_18 _followsYou_1v5na_105">Follows You</div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 2; background-color: unset; background-image: url(&quot;https://usermetadata.audius.co/content/QmNPkN1nwzLPkLtN1tBcnTF87Hf7NmnQRPbquA6opcgmhn/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 1; background-color: unset;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>_insightt</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><img draggable="false" alt="" src="data:image/webp;base64,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" width="14" height="14"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@tokegod</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">48.3K</span><span>Followers</span></div><div class="_badge_1fx8m_1 _list_1fx8m_18 _followsYou_1v5na_105">Follows You</div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://usermetadata.audius.co/content/01HADGV8T10WPAYEPR25T9VTWT/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Duke &amp; Jones</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@DukeandJones</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">32.4K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://audius-content-3.figment.io/content/QmYBB732EeBFDHmugP2DbU7bg9Ci6ctsunSbFAhuJRGPZP/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>So Tuff So Cute</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><img draggable="false" alt="" src="data:image/webp;base64,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" width="14" height="14"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@sotuffsocute</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">28.4K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://cn4.mainnet.audiusindex.org/content/QmRqnQkffvm7NMrRVEEjNu9VeVCkLwuqm1yqz374TbU3iu/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Denni den</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,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"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@denniden__</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">25.2K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://audius-content-2.cultur3stake.com/content/QmWSjF28zq8ttSVfPEsrexRcgvUdBXn7rsaZatrqwMwJVw/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Shoffy</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@shoffymusic</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">22.2K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://audius-content-3.cultur3stake.com/content/QmTtcodg7GDkzR55fSbV7QG3VCUUiY2MAUuqNZdjjXZ2y8/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Candyland</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg><img draggable="false" alt="" src="data:image/webp;base64,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" width="14" height="14"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@CandylandDJs</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">21K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://audius-creator-1.theblueprint.xyz/content/QmQN4dAMikshcxM8yjdgytgC21NRKcEcj7DMqHkoEevAty/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>look out loren</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,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"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@lookoutloren</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">18.2K</span><span>Followers</span></div><div class="_badge_1fx8m_1 _list_1fx8m_18 _followsYou_1v5na_105">Follows You</div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://audius-content-13.figment.io/content/01HJ6KQWT0Z3VVRM5G8J1SCY94/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>camoufly</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,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"></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@camouflybeats</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">17.8K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1 _notLastUser_11o7n_14"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://creatornode.audius8.prod-eks-ap-northeast-1.staked.cloud/content/QmdJDXpmjPdr9NJN32BKgpdd5aQuE4Cuy8JqR54ircUcXH/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>Kevin McKay</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg><img draggable="false" width="14" height="14" alt="" src="data:image/webp;base64,UklGRroIAABXRUJQVlA4WAoAAAAQAAAAXwAAXwAAQUxQSJQCAAABkKztnyE7/381xt7GyQXY5opr27Zt27aTVbI9PmcZr2twATV9BRVVo+of7SJiAuB/ae+5Z+6850JKKQVveLN3Wm9KRu9pEDJE0bC2N1Iw+oyQEfK7vdGs/NoGGfmHuWhOfo+QWvK5aMgaIbXlc9GA0Q1Sa94dNcufldrvQ626cWkg74H6zBXSSLEOddkjjd2HetyVBp9nOtyRRt+3orsjDb9nRXVWGn/PimaPJHA/i2KNJHE+htdN0CB6hsclkeViWHskmedZON0koePD4ZQ0WWHMlaRuxBA4LfVSsLmS2P0YiFNTLwWZK8ndgAHe09Ni++stCZ7o7w5FF5kvTlHd8dNbkjzRz1qaDjMfDTS12j4ETfWYqrckejAqplG1hCn2UnXZUryh6omqgarPjoJTVY0rBFVeQiHJTpKXRupS8LsQVHkqTlU1qXhPVVtMcZeqd67iLFXHbMVcqmYxRW+qRqhA0ORlQd1AU1vCx16adjo+RtM0kvkAQVE1g37OUvTEBb+jKRrFfEEDPV+T6G8tPats8J8X1NQKGAD2UrMuBkELgpZaEQPBWlrWxSA4NlJSzbEQYDQl/RwMA87ScSoJ4RY4FbUCQwwFeggavH4uQtjzadiZwPBwHwWnUywCwHvm3S5YiBAhu2/ai7yNCJFa9816kbcwKmAXTHpRtBEZYjTADphzJucggoa4TpjhrU3ZCFoA9uIm1PrHLQRt2X79bnR1ETUC7FXWq2NagoHu1sKKPt6OnIOgP9qLK3p4J7o6CGaiu/hTdB07O7kMzEV70INKFN61yWkHwXDmDNrcUg/Dazs+KeMyBArRjg+ZfuRtW9X7yat+fnptxYhs3GZAKbNsN55Ip9OpVDIesxlDoBnhrxtWUDggAAYAAFAjAJ0BKmAAYAA+MRSHQqIhDDyjwhABglnAMLdsIl1ZI+M29h/wd/UDwRfjl0VPsZlQvznErtXf2rfNOIfzb/L/a1z69tDx+kcv+G+2b5S/8n7gPcx9Sf9T3Bf43/Of8J/ZP3j/uvgb9Aj9J2IMtEu/55LFJsqJnnR2GoT+JN8lZMBHU8B9xvhJmrE+DgoIRmvw6xcjUrI52sXTI5RkMtfMciSj28flFq0rA3jlsBPs7mtaaTrDjmM1J0+QZ3X3iffgBPMMvfwdHuqUIsokYtoDvdV7WLFhEUwHQBFteeHpi0L7T+VanfEw3FAkaV0GrvwkVcgGsI4sIRZlCFt5//nGGxvkNC9nWGnXonlSJC7aij9Ve5Qyfl6EoSK1dQf/pA3LYAD+/2AYhf63tjACXv+t+PQMT/fl85iIayIfspKEdWBfea5hSTV6EAs9dmTMqx1OVWbm/KV4FzuxrlIRX8Nq2oozbGTJRnqDUDf1887rXFXVeTq/SmsvBD4KUZvUdIA3QfhMp7P7Qspib1urOhudmpVcUslEFOgQXQ+EuLpbtuGjAcoLp9+iXpWT+G7S0Jqla8tkLf/hYVq/d54igAEF/W9vulogcbnNHgtQu6tOqk89ENCSODDLxxFrP8Ss37jpVxNyiiXBAVTAXCA5HKxUmGiUZWduFGj629AzpzgOER+jCW4VABznGXH7WHW6PN1gWF4Tcb+cppe8ow87TtiAsszyKx0GJQiyGHiIGJQRoCDab6p0EcMGCNDk5gnYdRriikb1L1fLseXWJIJ22JxopehDeef8hwv/gnt4vLUCupdZNX3ovSn3GrevVo+Mq9lg8OWFumTw8+TuWZ+in8h46rj3MrG7hEdoSJQ6DVzj7VL6MTbHNqthyU+Vopp2TIxtGJarfbLGpXeJo4EramgFxSfeHrr1axgHXpu8odrloox0LQyLhsoaAhLHeFniMLbDBQAmrE9nQPufhZ9NRZ0s2XJLLxjDtKfMg+6nf0UpfJPWj/SrzfCEvZBhXg/Iy/0QcFTARRKEp4FKaeMEKcDD/zlTBoTEp7apsixKI+olaBXBRji5HOyASw+P2zhoRMskbfuvdU+EkfoLTLGznnCq/GdZJ+s2ypcuOQ7a/ArMN6NRIK7A4dH21MpVH/dK+2LDq4OvlAguPJLRbgfLTL6B2ObVOFQlMFOMYCeEnaE/5M+9ekZOtiYahmxcuLQz1J5GL02+ttUI5pxY7pfHv6//jDKj2mhaKZIYWVUncCSmuBPA1XX34gGwJx1IKWJxA29ZRaSCUNL/qYVzpbJCp3e9APCy6Tt5ApZdh+JO5BcGeIU7AlqKhguj2M4/CNcrv/1IAvjnP7DIyiJsGij7hf4lcYodxzoJg2usLuF/0LIfoW7KzgqQrpgJudyCFwdQHBIGH1QojqTD2DQXudKGdq8etGTVMt6E20D6TlEL7hhHkTo8zuZs2ViRExziui6jQZn1Ay8hZ1ag9R/F9zBCvuHasjdhrF/2zKIdq6zQu+DU4kcBp9q25lv4kUeVhp37d27JoO/A283UagNG7NkeoBDuzOH+l/0eEMHVnr1FiAV7f/xWyLAgQu4rvVo9/eRS23U8vZo6VZl//ttAmGd3f1fBNbZ/+3QkMqPxo1jJb7/be+5y4ucwmMIqguq2YWD9NkRKAagvJUDb3ncbuxyCoojqDkeh0ot8U2x7IbjDwXpJiXig95C20r5pFlfmOsDqZ2inogWkYvHvW7wCYGKXaypeXpFOYjrXY6EPtTrW5rb7Ux3WDSGkGMRTT2/vQlC8H4bVEYuAIcIb1N3YpH//VW+fHuNvL5W0/h5lISH+hLTz+Av3EDipomeQoJe70PlDCJk3jRkbAH/2neR9NljgMcSKdD/+vEvwtX2ndzmR4BWhcseWW4jstippBBCJse7grr/KYN//F3+EleiL3EgLY2Xw/09CRmaryDrV4N9WfgSPkk2PGni60PyodHmbhwdUYYDeIn/gm/jbj1NB8i6rTZ0qAZTET//KUKNVzFg7CSxNCtwWh8zOKe9JpSgCqCAAAA=="></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@kevinmckay</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">17.1K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_user_11o7n_1"><div class="_artistChip_1v5na_1"><div class="artistPopover"><div class="_wrapper_1jw80_1 _profilePictureWrapper_1v5na_11 harmony-1vqzjfh" role="img"><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="z-index: 1; background-color: unset; background-image: linear-gradient(315deg, var(--harmony-n-100) 0%, var(--harmony-n-50) 100%); transition: unset; opacity: 1; animation: auto ease 0s 1 normal none running none;"></div><div class="_image_1jw80_18 _profilePicture_1v5na_11 _clickable_1v5na_30" style="animation: auto ease 0s 1 normal none running none; z-index: 2; background-color: unset; background-image: url(&quot;https://audius-content-1.cultur3stake.com/content/QmQNJ23P4GF34xokw5238KPoaKYM4C6RuVkNz1xoT2CEN2/150x150.jpg&quot;); transition: opacity 0.5s ease-in-out 0s; opacity: 1;"></div></div></div><div class="_text_1v5na_37"><div class="_identity_1v5na_47 name _clickable_1v5na_30"><div><div class="artistPopover"><div class="_name_1v5na_66"><span>R3SPAWN</span><span class="_inlineContainer_rrnw5_7 _badge_1v5na_62"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 25 25" class="css-62cknl" aria-hidden="true" fillColor="red"><path fill="#CC0FE0" fill-rule="evenodd" d="M12.8 22.5c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10Zm3.667-14.62a.97.97 0 0 1 .678-.376.944.944 0 0 1 .725.254 1.1 1.1 0 0 1 .344.733c.02.285-.067.566-.24.782l-6.24 7.853a.965.965 0 0 1-.737.374h-.015a.96.96 0 0 1-.732-.348l-3.023-3.57a1.132 1.132 0 0 1 .063-1.514.942.942 0 0 1 1.402.069l2.266 2.676 5.509-6.934Z" clip-rule="evenodd"></path><path fill="#fff" fill-rule="evenodd" d="M17.145 7.504a.97.97 0 0 0-.678.375l-5.508 6.934-2.267-2.676a.942.942 0 0 0-1.402-.069 1.132 1.132 0 0 0-.063 1.514l3.023 3.57a.96.96 0 0 0 .732.348h.015a.965.965 0 0 0 .738-.374l6.238-7.853c.174-.216.26-.497.241-.782a1.1 1.1 0 0 0-.344-.733.944.944 0 0 0-.725-.254Z" clip-rule="evenodd"></path></svg></span></div></div><div class="artistPopover"><div class="_handle_1v5na_71">@r3spawnmusic</div></div></div></div><div class="_followersContainer_1v5na_84"><div class="_followers_1v5na_84 followers"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" class="css-0 _icon_1v5na_75" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M16.793 12.495c2.8 1.294 4.68 3.685 4.68 6.422 0 4.11-18.947 4.11-18.947 0 0-2.737 1.88-5.129 4.68-6.422A7.337 7.337 0 0 0 12 14.268a7.34 7.34 0 0 0 4.687-1.683l.106-.09ZM12 2a5.263 5.263 0 1 1 0 10.526A5.263 5.263 0 0 1 12 2Z" clip-rule="evenodd"></path></svg><span class="_value_1v5na_100">17K</span><span>Followers</span></div></div></div></div><button class="harmony-7dahz9"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" class="css-1216syj harmony-1hlc6ca" aria-hidden="true" fillColor="red"><path fill="red" fill-rule="evenodd" d="M6.042 12.427a6.336 6.336 0 0 0 4.14 1.531 6.334 6.334 0 0 0 3.638-1.141c-1.28 2.248-1.253 5.57.352 7.462l.06.068-.02-.022C9.365 21.14 2 20.355 2 17.973c0-2.363 1.624-4.429 4.042-5.546Zm13.02.027a.42.42 0 0 1 .42.42v2.098h2.098a.42.42 0 0 1 .42.42v1.398a.42.42 0 0 1-.42.42h-2.097v2.097a.42.42 0 0 1-.42.42h-1.399a.42.42 0 0 1-.42-.42V17.21h-2.097a.42.42 0 0 1-.42-.42v-1.398a.42.42 0 0 1 .42-.42h2.098v-2.097a.42.42 0 0 1 .42-.42h1.398Zm-8.88-9.09a4.545 4.545 0 1 1 0 9.09 4.545 4.545 0 0 1 0-9.09Z" clip-rule="evenodd"></path></svg><span class="harmony-i38i02">Follow</span></button></div><div class="_loadingAnimation_11o7n_23"><div title="" role="button" aria-label="animation" tabindex="0" style="width: 100%; height: 100%; overflow: hidden; margin: 0px auto; outline: none;"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 48 48" width="48" height="48" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; transform: translate3d(0px, 0px, 0px); content-visibility: visible;"><defs><clipPath id="__lottie_element_71"><rect width="48" height="48" x="0" y="0"></rect></clipPath></defs><g clip-path="url(#__lottie_element_71)"><g transform="matrix(0.9999140501022339,0.013112854212522507,-0.013112854212522507,0.9999140501022339,28.661029815673828,29.671607971191406)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,-4.735000133514404,-5.610000133514404)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke-dasharray=" 0.18325188549444796 236" stroke-dashoffset="0" stroke="rgb(255,255,255)" stroke-opacity="1" stroke-width="6" d=" M0,-16 C8.830400466918945,-16 16,-8.830400466918945 16,0 C16,8.830400466918945 8.830400466918945,16 0,16 C-8.830400466918945,16 -16,8.830400466918945 -16,0 C-16,-8.830400466918945 -8.830400466918945,-16 0,-16z"></path></g></g><g style="display: none;" transform="matrix(-0.9997464418411255,0.02251766249537468,0.02251766249537468,0.9997464418411255,19.892398834228516,29.70393943786621)" opacity="1"><g opacity="1" transform="matrix(1,0,0,1,-4.235000133514404,-5.610000133514404)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke-dasharray=" 0.0469208926442235 236" stroke-dashoffset="0" stroke="rgb(255,255,255)" stroke-opacity="1" stroke-width="6" d=" M0,-16 C8.830400466918945,-16 16,-8.830400466918945 16,0 C16,8.830400466918945 8.830400466918945,16 0,16 C-8.830400466918945,16 -16,8.830400466918945 -16,0 C-16,-8.830400466918945 -8.830400466918945,-16 0,-16z"></path></g></g></g></svg></div></div></div></div></div><div class="ps__rail-x" style="width: 9px; left: 0px; bottom: 0px;"><div class="ps__thumb-x" tabindex="0" style="left: 0px; width: 0px;"></div></div><div class="ps__rail-y" style="top: 0px; height: 682px; right: 0px;"><div class="ps__thumb-y" tabindex="0" style="top: 0px; height: 320px;"></div></div></div></div>

---

## Assistant

To scroll within a modal using a combination of CSS and JavaScript, you can follow these steps:

### Step 1: CSS for Scrolling
Ensure that the modal content has a fixed height and overflow property set to `auto` to allow scrolling within it.

```css
.modal-content {
  max-height: 80vh; /* Adjust based on the desired height */
  overflow-y: auto;
}
```

### Step 2: JavaScript for Scrolling
To programmatically scroll the modal content, you can use JavaScript. Here's an example function to scroll the modal content to the bottom:

```javascript
function scrollToBottom() {
  const modalContent = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');
  modalContent.scrollTop = modalContent.scrollHeight;
}
```

### Step 3: Setting an Interval for Repeated Scrolling
If you need to repeatedly scroll the modal content, you can use `setInterval` in JavaScript. Here's an example that scrolls to the bottom every 5 seconds:

```javascript
function startScrolling() {
  setInterval(scrollToBottom, 5000); // Adjust the interval as needed
}

function scrollToBottom() {
  const modalContent = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');
  modalContent.scrollTop = modalContent.scrollHeight;
}

startScrolling();
```

### Step 4: Handling Scrolling on Load
Ensure that your JavaScript runs after the modal content is loaded. You might need to place your script at the end of the HTML body or use an event listener for `DOMContentLoaded`.

```javascript
document.addEventListener('DOMContentLoaded', (event) => {
  startScrolling();
});
```

### Full Example
Here's a full example combining everything:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Modal Scrolling</title>
  <style>
    .modal-content {
      max-height: 80vh; /* Adjust based on the desired height */
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <div class="Modal-module_body__efFIt">
    <div class="scrollbar-container modal-content">
      <!-- Modal content goes here -->
    </div>
  </div>

  <script>
    function scrollToBottom() {
      const modalContent = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');
      modalContent.scrollTop = modalContent.scrollHeight;
    }

    function startScrolling() {
      setInterval(scrollToBottom, 5000); // Adjust the interval as needed
    }

    document.addEventListener('DOMContentLoaded', (event) => {
      startScrolling();
    });
  </script>
</body>
</html>
```

This setup ensures that the modal content scrolls to the bottom at a specified interval, making it easier to manage dynamically loaded content. Adjust the `max-height` and interval time as needed to fit your requirements.

---

## User

has to be done with only console code

---

## Assistant

To scroll within the modal using only console code, you can directly manipulate the scroll properties of the modal element. Here’s how you can do it:

1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Execute the following JavaScript code to scroll the modal content:

```javascript
// Select the modal element
var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

// Scroll down by 100 pixels
modal.scrollBy(0, 100);

// Scroll up by 100 pixels
// modal.scrollBy(0, -100);
```

You can adjust the pixel value (100 in this case) to scroll by different amounts. For continuous scrolling, you can use a loop or interval:

```javascript
// Scroll down continuously by 100 pixels every 1 second
var scrollInterval = setInterval(function() {
    modal.scrollBy(0, 100);
}, 1000);

// To stop the continuous scrolling
// clearInterval(scrollInterval);
```

This will scroll the content of the modal down by 100 pixels every second. You can stop the scrolling by calling `clearInterval(scrollInterval)`.

---

## User

modal is not defined

---

## Assistant

If `modal` is not defined, it means the query selector did not find the element. Let's try a more robust approach to ensure we are selecting the correct element.

Here is the modified code to scroll the modal using the console:

1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Execute the following JavaScript code:

```javascript
// Select the modal element by class name or other unique identifier
var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

// Check if the modal was found
if (modal) {
    // Scroll down by 100 pixels
    modal.scrollBy(0, 100);

    // Scroll up by 100 pixels
    // modal.scrollBy(0, -100);
} else {
    console.log('Modal element not found');
}
```

If the selector `.Modal-module_body__efFIt .scrollbar-container` is not correct, you might need to inspect the modal element in the developer tools and update the selector accordingly. For example:

- Right-click on the modal content and select "Inspect".
- Look for the class names or unique attributes that identify the modal.
- Update the query selector in the script to match the modal's actual class names or attributes.

If you provide more details about the modal's HTML structure, I can help you create a more accurate selector.

---

## User

that owrks now add clicking the follow buttons with the code from above. lets scroll and click and scroll and click with random delays

---

## Assistant

To scroll the modal and click the "Follow" buttons with random delays, you can use the following JavaScript code. This script will scroll down, find "Follow" buttons, click them, and then continue scrolling and clicking with random delays.

```javascript
function scrollAndClick() {
    // Select the modal element by class name or other unique identifier
    var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

    if (!modal) {
        console.log('Modal element not found');
        return;
    }

    // Function to click all "Follow" buttons visible in the modal
    function clickFollowButtons() {
        // Select all "Follow" buttons within the modal
        var followButtons = modal.querySelectorAll('button:contains("Follow")');

        followButtons.forEach(function(button) {
            if (button.innerText.includes("Follow")) {
                button.click();
            }
        });
    }

    // Function to perform the scroll and click actions with random delays
    function performScrollAndClick() {
        // Scroll down by 100 pixels
        modal.scrollBy(0, 100);

        // Click the follow buttons
        clickFollowButtons();

        // Generate a random delay between 500ms and 1500ms
        var delay = Math.random() * (1500 - 500) + 500;

        // Set a timeout to call this function again after the random delay
        setTimeout(performScrollAndClick, delay);
    }

    // Start the scroll and click process
    performScrollAndClick();
}

// Start the script
scrollAndClick();
```

### Instructions:
1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Copy and paste the above JavaScript code into the console.
3. Press `Enter` to execute the script.

This script will:
1. Scroll the modal down by 100 pixels.
2. Find and click all "Follow" buttons currently visible within the modal.
3. Wait for a random delay between 500ms and 1500ms.
4. Repeat the process until you stop the script or the modal no longer scrolls.

---

## User

VM8689:13 Uncaught DOMException: Failed to execute 'querySelectorAll' on 'Element': 'button:contains("Follow")' is not a valid selector.
    at clickFollowButtons (<anonymous>:13:35)
    at performScrollAndClick (<anonymous>:28:9)
    at scrollAndClick (<anonymous>:38:5)
    at <anonymous>:42:1

---

## Assistant

The error is due to the use of an incorrect CSS selector. `querySelectorAll` does not support `:contains` pseudo-class. Instead, we need to use a different approach to find elements by their text content. Here's the revised code:

```javascript
function scrollAndClick() {
    // Select the modal element by class name or other unique identifier
    var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

    if (!modal) {
        console.log('Modal element not found');
        return;
    }

    // Function to click all "Follow" buttons visible in the modal
    function clickFollowButtons() {
        // Select all button elements within the modal
        var buttons = modal.querySelectorAll('button');

        buttons.forEach(function(button) {
            if (button.innerText === "Follow") {
                button.click();
            }
        });
    }

    // Function to perform the scroll and click actions with random delays
    function performScrollAndClick() {
        // Scroll down by 100 pixels
        modal.scrollBy(0, 100);

        // Click the follow buttons
        clickFollowButtons();

        // Generate a random delay between 500ms and 1500ms
        var delay = Math.random() * (1500 - 500) + 500;

        // Set a timeout to call this function again after the random delay
        setTimeout(performScrollAndClick, delay);
    }

    // Start the scroll and click process
    performScrollAndClick();
}

// Start the script
scrollAndClick();
```

### Instructions:
1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Copy and paste the above JavaScript code into the console.
3. Press `Enter` to execute the script.

This script will:
1. Scroll the modal down by 100 pixels.
2. Find and click all "Follow" buttons currently visible within the modal by checking the button text.
3. Wait for a random delay between 500ms and 1500ms.
4. Repeat the process until you stop the script or the modal no longer scrolls.

---

## User

thats scrolling nicely with no errors but it needs to click all the buttons too which it doesnt seem to current be doing

---

## Assistant

It seems the issue might be with the scope or timing of the button selection and clicks. We should ensure that the buttons are correctly selected and clicked each time the function is called. Here's an improved version:

```javascript
function scrollAndClick() {
    // Select the modal element by class name or other unique identifier
    var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

    if (!modal) {
        console.log('Modal element not found');
        return;
    }

    // Function to click all "Follow" buttons visible in the modal
    function clickFollowButtons() {
        // Select all button elements within the modal
        var buttons = modal.querySelectorAll('button');

        buttons.forEach(function(button) {
            if (button.innerText === "Follow") {
                button.click();
            }
        });
    }

    // Function to perform the scroll and click actions with random delays
    function performScrollAndClick() {
        // Click the follow buttons first
        clickFollowButtons();

        // Scroll down by 100 pixels
        modal.scrollBy(0, 100);

        // Generate a random delay between 500ms and 1500ms
        var delay = Math.random() * (1500 - 500) + 500;

        // Set a timeout to call this function again after the random delay
        setTimeout(performScrollAndClick, delay);
    }

    // Start the scroll and click process
    performScrollAndClick();
}

// Start the script
scrollAndClick();
```

### Instructions:
1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Copy and paste the above JavaScript code into the console.
3. Press `Enter` to execute the script.

This version ensures that each time `performScrollAndClick` is called, it will first attempt to click all "Follow" buttons before scrolling. This sequence might help in ensuring the clicks are properly registered.

---

## User

lets just click all links after 10 scrolls then loop

---

## Assistant

To modify the script to scroll a set number of times and then click all "Follow" buttons, you can implement a counter to keep track of the number of scrolls. After a certain number of scrolls, the script will attempt to click all "Follow" buttons and then loop. Here’s the updated version:

```javascript
function scrollAndClick() {
    // Select the modal element by class name or other unique identifier
    var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

    if (!modal) {
        console.log('Modal element not found');
        return;
    }

    var scrollCount = 0;
    var maxScrolls = 10;  // Number of scrolls before clicking all "Follow" buttons

    // Function to click all "Follow" buttons visible in the modal
    function clickFollowButtons() {
        // Select all button elements within the modal
        var buttons = modal.querySelectorAll('button');

        buttons.forEach(function(button) {
            if (button.innerText === "Follow") {
                button.click();
            }
        });
    }

    // Function to perform the scroll and click actions with random delays
    function performScrollAndClick() {
        if (scrollCount >= maxScrolls) {
            // Click the follow buttons
            clickFollowButtons();
            // Reset scroll count
            scrollCount = 0;
        } else {
            // Scroll down by 100 pixels
            modal.scrollBy(0, 100);
            scrollCount++;
        }

        // Generate a random delay between 500ms and 1500ms
        var delay = Math.random() * (1500 - 500) + 500;

        // Set a timeout to call this function again after the random delay
        setTimeout(performScrollAndClick, delay);
    }

    // Start the scroll and click process
    performScrollAndClick();
}

// Start the script
scrollAndClick();
```

### Instructions:
1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Copy and paste the above JavaScript code into the console.
3. Press `Enter` to execute the script.

This script will scroll the modal down by 100 pixels 10 times, then click all "Follow" buttons, and repeat the process indefinitely with random delays between each action.

---

## User

use this code for the clicks:

const buttons = document.querySelectorAll('.harmony-7dahz9');
let delay = 100;

buttons.forEach((button, index) => {
  setTimeout(() => {
    button.click();
  }, delay * index);
});


---

## Assistant

To integrate your provided code for clicking the buttons into the existing scrolling script, we'll need to modify the `clickFollowButtons` function. Here’s the updated version:

```javascript
function scrollAndClick() {
    // Select the modal element by class name or other unique identifier
    var modal = document.querySelector('.Modal-module_body__efFIt .scrollbar-container');

    if (!modal) {
        console.log('Modal element not found');
        return;
    }

    var scrollCount = 0;
    var maxScrolls = 10;  // Number of scrolls before clicking all "Follow" buttons

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
            // Click the follow buttons
            clickFollowButtons();
            // Reset scroll count
            scrollCount = 0;
        } else {
            // Scroll down by 100 pixels
            modal.scrollBy(0, 100);
            scrollCount++;
        }

        // Generate a random delay between 500ms and 1500ms
        var delay = Math.random() * (1500 - 500) + 500;

        // Set a timeout to call this function again after the random delay
        setTimeout(performScrollAndClick, delay);
    }

    // Start the scroll and click process
    performScrollAndClick();
}

// Start the script
scrollAndClick();
```

### Instructions:
1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Copy and paste the above JavaScript code into the console.
3. Press `Enter` to execute the script.

This script will scroll the modal down by 100 pixels 10 times, then click all buttons with the class `.harmony-7dahz9`, and repeat the process indefinitely with random delays between each action.

---

## User

start with clicks then scroll 5 times then loop

---

## Assistant

Sure, we can modify the script to start by clicking all the buttons, then scroll five times, and repeat the process. Here’s how you can do it:

```javascript
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
            // Click the follow buttons
            clickFollowButtons();
            // Reset scroll count
            scrollCount = 0;
        } else {
            // Scroll down by 100 pixels
            modal.scrollBy(0, 100);
            scrollCount++;
        }

        // Generate a random delay between 500ms and 1500ms
        var delay = Math.random() * (1500 - 500) + 500;

        // Set a timeout to call this function again after the random delay
        setTimeout(performScrollAndClick, delay);
    }

    // Start by clicking all buttons, then perform scroll and click process
    clickFollowButtons();
    performScrollAndClick();
}

// Start the script
scrollAndClick();
```

### Instructions:
1. Open the browser's developer tools console (usually with `F12` or `Ctrl+Shift+I`).
2. Copy and paste the above JavaScript code into the console.
3. Press `Enter` to execute the script.

This script will initially click all the "Follow" buttons, then scroll five times, click the buttons again, and repeat the process indefinitely with random delays between each action.

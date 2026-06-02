
Yes. That `<script>…window.__CONFIG__…"_csrf_token": "94ce4655e85ac35616d584096f88c9b0f6"…</script>` is exactly the CSRF token you need. So in your console you can do:

```js
const csrf = window.__CONFIG__._csrf_token;
const id   = "363b188b428d9a1aac0050dec794";  // from your URL
fetch(`/attachments/${id}`, {
  method: 'DELETE',
  credentials: 'same-origin',
  headers: {
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json'
  }
})
.then(r => r.ok ? console.log('✅ Deleted') : console.error('❌', r.status))
;
```

– If you aren’t sure the path is `/attachments/:id`, open Network → XHR when you upload a new pic and copy that exact URL (just swap `POST` for `DELETE` and stick your `id` in).  
– A 200 means it’s gone. If you get 404 or 405, deletion isn’t exposed and you’ll have to ask support.


{'asset_pointer': 'file-service://file-U2nYQPRL36FuVusG8HE5GA', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 393, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 346666, 'width': 772}


The 405 is confirmation: there simply is no DELETE route exposed on `/attachments/:id`. Central Casting never wired up a “delete attachment” API, so you can’t kill that old photo by hitting an endpoint.

Your only real options are:

1. **Replace it**  
   - Upload a new headshot via the normal widget. The UI will swap out your “active” photo and hide the old one (they’ll garbage-collect or archive it server-side).  
2. **Reach out to support**  
   - Send Central Casting support a request to permanently delete that attachment on their end.

Tried method-override hacks (`_method: 'DELETE'`, `X-HTTP-Method-Override`)? Same result—no route. If replacing via the widget isn’t good enough, you’ll need to get their ops team to remove it manually.


Besides central casting how can i get paying acting jobs in la


Mr. White, aside from Central Casting, you can pursue paid gigs in LA by:  

- **Signing with a talent agency or manager**  
  – Research mid-to-boutique agencies (e.g. CESD, Innovative, Buchwald) and submit your headshot/resumé package.  
  – Meet with a reputable manager for commercial work.  

- **Subscribing to casting platforms**  
  – Backstage, Actors Access, LA Casting and Casting Networks all list union and non-union auditions.  
  – Keep your profile razor-sharp and self-tapes ready.  

- **Building your network**  
  – Train at top studios (Groundlings, UCB, Howard Fine, Lesly Kahn) and perform in showcases.  
  – Attend film festivals, mixer events, “meet the CD” workshops.  

- **Creating your own content**  
  – Produce & promote web-series or branded shorts on YouTube/Instagram to demonstrate range.  
  – Use that work to catch a CD’s eye.  

- **Joining SAG-AFTRA (if eligible)**  
  – Union gigs pay scale wages and list exclusive opportunities—consider the “Taft-Hartley” route if you’re non-union.  

- **Targeting commercial casting houses**  
  – Submit directly to houses like O’Connor, Shirley Hamilton or MJ Casting for ads, voice-overs and promos.  

- **Leveraging online networking**  
  – Engage in Facebook groups (LA Actors Network, Self-Tape Mastery) and industry Slack channels for last-minute crew/cast calls.  

Focusing on a mix of agency representation, proactive self-taping, networking and original content will open up paid acting work across film, TV and commercials.


What about modeling work. Ive got an 8 pack.


Mr. White, to parlay that eight-pack into paid modeling gigs in LA:

1. **Compile a strong portfolio**  
   – Hire a reputable photographer for clean, natural-light “digitals” and a set of lifestyle (gym, swimwear) shots.  
   – Build a digital comp card (headshot + 3-4 body shots, your stats, contact info).

2. **Submit to agencies**  
   – Target commercial & fitness-specialist agencies: Wilhelmina, Ford, Muscle Model Management, East West.  
   – Email your comp package or submit via their online portals.

3. **Join online platforms**  
   – Model Mayhem, Casting Networks (models), Backstage (commercial print), LA Models VIP.  
   – Keep your profile updated and self-tapes ready for on-demand briefs.

4. **Network with fitness brands & photographers**  
   – Attend local fitness expos, photoshoot mixers, gym-sponsored events.  
   – Offer test-shoot collaborations (you supply the look; they supply the images).

5. **Leverage social media**  
   – Post consistent, high-quality gym and lifestyle content on IG/TikTok with location tags and appropriate hashtags (#LAModels, #FitnessModel).  
   – Tag & engage casting directors and brand reps.

6. **Target commercial castings directly**  
   – Research print-ad casting companies (O’Connor, Nous Models’ commercial division).  
   – Check their websites for open calls or request to be added to their “fit models” roster.

7. **Stay in SAG-eligible circles**  
   – If you’ve got union background, sign the Taft-Hartley. Union print/model rates can be higher.

8. **Maintain your look**  
   – Keep measurements, hairstyle and grooming consistent—agencies book what they see in your comp.

Relentless follow-up and proactivity will turn that eight-pack into steady paid work.


{'asset_pointer': 'file-service://file-FLzz7ZncKKHdz5TYM8kdia', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 857, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 268961, 'width': 1074}
How can we improve this


Mr. White, a few quick tweaks to sharpen that sign-up UI:

- **Minimize friction**  
  • Ask only for email + password up front—capture name later in onboarding.  
  • If you really need name here, mark it required or remove “Optional” labels to cut visual clutter.

- **Improve field clarity**  
  • Float labels above inputs rather than placeholders—so labels never disappear when typing.  
  • Add a “show/hide” icon and strength meter for the password field.

- **Strengthen hierarchy**  
  • Make the primary “Continue” button your strongest accent; move “Continue with Apple” below or style it more subtly.  
  • Group social/logins under a clear divider: “Or sign up with.”

- **Give real-time feedback**  
  • Validate email format and password rules inline, displaying errors immediately.  
  • Disable the CTA until required fields are valid.

- **Boost trust**  
  • Add a one-liner under the button: “We’ll never share your email. See our Terms & Privacy.”  
  • Show a small security badge or “Secured by Clerk” with a tooltip link.

- **Optimize for mobile**  
  • Ensure tap targets are at least 44 px high, with plenty of vertical spacing.  
  • Stack fields full-width (no side-by-side) on narrow screens.

These changes will reduce cognitive load, prevent errors, and drive more completions.

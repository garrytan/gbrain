---
conversation_id: 8c904b2e-0859-4f22-9826-aa5c4ff3cb00
created: 2023-05-12
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 10
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Vue.js Component Overview
type: guide
updated: 2023-05-12
---

# Vue.js Component Overview

**Related:** [[coding_web_dev]]

> Conversation ID: 8c904b2e-0859-4f22-9826-aa5c4ff3cb00
> Created: 2023-05-12T18:04:06Z
> Updated: 2023-05-12T18:08:10Z
> Messages: 10

---

## User


<script>
import { Head } from '@vueuse/head';
import JovieLogo from '../components/JovieLogo.vue';
import AlertBanner from '../components/AlertBanner.vue';
import {
  InboxIcon,
  PencilIcon,
  TrashIcon,
  UserIcon,
  UsersIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  UserGroupIcon,
  EnvelopeIcon,
  CircleStackIcon,
  LightBulbIcon,
  Bars3Icon,
  BellIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline';
import UserService from '../services/api/user.service';
import ExternalFooter from '../components/External/ExternalFooter.vue';
import {
  Popover,
  PopoverButton,
  PopoverPanel,
  PopoverOverlay,
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
} from '@headlessui/vue';

export default {
  name: 'Default',

  components: {
    InboxIcon,
    AlertBanner,
    Head,
    LightBulbIcon,
    PencilIcon,
    TrashIcon,
    UsersIcon,
    UserIcon,
    Bars3Icon,
    XMarkIcon,
    BellIcon,
    ExternalFooter,
    ChevronDownIcon,
    MagnifyingGlassIcon,
    UserGroupIcon,
    EnvelopeIcon,
    JovieLogo,
    CircleStackIcon,
    Popover,
    PopoverButton,
    PopoverPanel,
    PopoverOverlay,
    Disclosure,
    DisclosureButton,
    DisclosurePanel,
    Menu,
    MenuButton,
    MenuItem,
    MenuItems,
  },
  data() {
    return {
      title: 'Jovie Social CRM | Organize everyone you follow.',
      scrollPosition: null,
      navigation: [
        { name: 'Pricing', href: '/pricing', current: false },
        { name: 'Get started free', href: '/signup', current: false },
      ],
      intergrations: [
        { name: 'Instagram', href: '/integrations/instagram', current: false },
        { name: 'Twitter', href: '/integrations/twitter', current: false },
        { name: 'LinkedIn', href: '/integrations/linkedin', current: false },
        { name: 'TikTok', href: '/integrations/tiktok', current: false },
        { name: 'Twitch', href: '/intergrations/twitch', current: false },
      ],
      features: [
        {
          name: 'Contact profiles',
          description: `Simple, beautiful, universal profiles.`,
          href: '/profiles',
          anchor: '#discovery',
          icon: 'UserIcon',
          label: 'New',
        },
        {
          name: 'Social CRM',
          description: 'Manage your relationships',
          href: '/',
          anchor: '#crm',
          icon: 'UserGroupIcon',
        },
        {
          name: 'Jovie for Chrome',
          description: `The Jovie Chrome Extension puts new & extsting contact\'s social data right inside your inbox`,
          href: 'chrome-extension',
          anchor: '',
          icon: 'CircleStackIcon',
        },
        {
          name: 'Data Enrichment',
          description:
            'Enrich your existing customer lists with creator specific data',
          href: 'Enrichment',
          anchor: '',
          icon: 'LightBulbIcon',
        },
      ],
      waitListEmail: '',
      acceptCookies: '',
      error: null,
      CommandPalletteOpen: false,
    };
  },
  mounted() {
    if (
      localStorage.theme === 'dark' ||
      (!('theme' in localStorage) &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    ) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

    this.acceptCookies = this.$cookies.get('acceptCookies');
    if (this.acceptCookies) {
      this.$store.commit('setAcceptCookies', true);
    }
    window.addEventListener('scroll', this.updateScroll);
    if (this.currentUser) {
      window.Atlas.start();
      window.analytics.identify(this.currentUser.email, {
        email: this.currentUser.email,
        name: this.currentUser.first_name + ' ' + this.currentUser.last_name,
        instagram: this.currentUser.instagram_handler,
        twitter: this.currentUser.twitter_handler,
        linkedin: this.currentUser.linkedin_handler,
        tiktok: this.currentUser.tiktok_handler,
        twitch: this.currentUser.twitch_handler,
        youtube: this.currentUser.youtube_handler,
        team: this.currentUser.current_team?.name,
        user_id: this.currentUser.id,
        userId: this.currentUser.id,
        companyId: this.currentUser.current_team?.id,
        appId: 'Jovie_Web_App',
        theme: localStorage.theme,
      });
    }
  },

  methods: {
    updateScroll() {
      this.scrollPosition = window.scrollY;
    },
    toggleAcceptCookies() {
      this.acceptCookies = true;
      this.$cookies.set('acceptCookies', true, 60 * 60 * 24 * 365);
    },
    login() {
      // login()
    },
    logout() {
      // logout()
    },
    scrollFix: function (hashbang) {
      location.hash = hashbang;
    },

    async requestDemo() {
      await UserService.addToWaitList({ email: this.waitListEmail })
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.$store.commit('setAddedToWaitList');
            this.waitListEmail = '';
            this.error = null;
            this.$router.push('demo');
          }
        })
        .catch((error) => {
          error = error.response;
          if (error.status == 422) {
            this.error = error.data.errors.email[0];
          }
        });
    },
  },
};
</script>
<style>
/* your style */
</style>


---

## Assistant

The code you provided appears to be a Vue.js component. It defines a component named "Default" with various imported components and data properties.

The imported components include:

- `Head`: A component from the `@vueuse/head` library.
- `JovieLogo`: A custom component.
- `AlertBanner`: A custom component.
- Several icons from the `@heroicons/vue` package, such as `InboxIcon`, `PencilIcon`, `TrashIcon`, etc.
- `ExternalFooter`: A custom component.
- Various components from the `@headlessui/vue` package, such as `Popover`, `Disclosure`, `Menu`, etc.

The component's data contains properties such as:

- `title`: A string representing the page title.
- `scrollPosition`: A variable to store the current scroll position.
- `navigation`: An array of objects representing navigation links.
- `intergrations`: An array of objects representing integration links.
- `features`: An array of objects representing different features with their descriptions and icons.
- `waitListEmail`: A string to store the email for the waitlist.
- `acceptCookies`: A variable to track if the user has accepted cookies.
- `error`: A variable to store any errors.
- `CommandPalletteOpen`: A boolean to track the state of a command palette.

The component also defines various methods for handling events, such as `updateScroll`, `toggleAcceptCookies`, `login`, `logout`, `scrollFix`, and `requestDemo`.

The code you provided doesn't include the template or the associated CSS styles. If you need further assistance, please provide the complete code or specify what specific information you are looking for.

---

## User

convert the imports to use vue dynamic imports

---

## Assistant

To convert the imports to use Vue dynamic imports, you can modify the script section of your code as follows:

```javascript
export default {
  name: 'Default',
  components: {
    // ...
  },
  data() {
    return {
      // ...
    };
  },
  mounted() {
    // ...
  },
  methods: {
    // ...
  },
};
```

Note that the changes only affect the import statements. The rest of the code remains the same.

By default, Vue supports dynamic imports for components, so you can dynamically import the components using the `() => import()` syntax. Here's how you can modify the import statements to use dynamic imports:

```javascript
export default {
  name: 'Default',
  components: {
    Head: () => import('@vueuse/head'),
    JovieLogo: () => import('../components/JovieLogo.vue'),
    AlertBanner: () => import('../components/AlertBanner.vue'),
    InboxIcon: () => import('@heroicons/vue/24/outline').then(module => module.InboxIcon),
    PencilIcon: () => import('@heroicons/vue/24/outline').then(module => module.PencilIcon),
    TrashIcon: () => import('@heroicons/vue/24/outline').then(module => module.TrashIcon),
    UserIcon: () => import('@heroicons/vue/24/outline').then(module => module.UserIcon),
    UsersIcon: () => import('@heroicons/vue/24/outline').then(module => module.UsersIcon),
    ChevronDownIcon: () => import('@heroicons/vue/24/outline').then(module => module.ChevronDownIcon),
    MagnifyingGlassIcon: () => import('@heroicons/vue/24/outline').then(module => module.MagnifyingGlassIcon),
    UserGroupIcon: () => import('@heroicons/vue/24/outline').then(module => module.UserGroupIcon),
    EnvelopeIcon: () => import('@heroicons/vue/24/outline').then(module => module.EnvelopeIcon),
    CircleStackIcon: () => import('@heroicons/vue/24/outline').then(module => module.CircleStackIcon),
    LightBulbIcon: () => import('@heroicons/vue/24/outline').then(module => module.LightBulbIcon),
    Bars3Icon: () => import('@heroicons/vue/24/outline').then(module => module.Bars3Icon),
    BellIcon: () => import('@heroicons/vue/24/outline').then(module => module.BellIcon),
    XMarkIcon: () => import('@heroicons/vue/24/outline').then(module => module.XMarkIcon),
    ExternalFooter: () => import('../components/External/ExternalFooter.vue'),
    Popover: () => import('@headlessui/vue').then(module => module.Popover),
    PopoverButton: () => import('@headlessui/vue').then(module => module.PopoverButton),
    PopoverPanel: () => import('@headlessui/vue').then(module => module.PopoverPanel),
    PopoverOverlay: () => import('@headlessui/vue').then(module => module.PopoverOverlay),
    Disclosure: () => import('@headlessui/vue').then(module => module.Disclosure),
    DisclosureButton: () => import('@headlessui/vue').then(module => module.DisclosureButton),
    DisclosurePanel: () => import('@headlessui/vue').then(module => module.DisclosurePanel),
    Menu: () => import('@headlessui/vue').then(module => module.Menu),
    MenuButton: () => import('@headlessui/vue').then(module => module.MenuButton),
    MenuItem: () => import('@headlessui/vue').then(module => module.MenuItem

---

## User

do i remove the regular import statement?

---

## Assistant

Yes, when using dynamic imports, you can remove the regular import statements because the components will be dynamically imported at runtime. Only the dynamic import statements should remain in the `components` section.

Here's the modified code with the regular import statements removed:

```javascript
export default {
  name: 'Default',
  components: {
    Head: () => import('@vueuse/head'),
    JovieLogo: () => import('../components/JovieLogo.vue'),
    AlertBanner: () => import('../components/AlertBanner.vue'),
    InboxIcon: () => import('@heroicons/vue/24/outline').then(module => module.InboxIcon),
    PencilIcon: () => import('@heroicons/vue/24/outline').then(module => module.PencilIcon),
    TrashIcon: () => import('@heroicons/vue/24/outline').then(module => module.TrashIcon),
    UserIcon: () => import('@heroicons/vue/24/outline').then(module => module.UserIcon),
    UsersIcon: () => import('@heroicons/vue/24/outline').then(module => module.UsersIcon),
    ChevronDownIcon: () => import('@heroicons/vue/24/outline').then(module => module.ChevronDownIcon),
    MagnifyingGlassIcon: () => import('@heroicons/vue/24/outline').then(module => module.MagnifyingGlassIcon),
    UserGroupIcon: () => import('@heroicons/vue/24/outline').then(module => module.UserGroupIcon),
    EnvelopeIcon: () => import('@heroicons/vue/24/outline').then(module => module.EnvelopeIcon),
    CircleStackIcon: () => import('@heroicons/vue/24/outline').then(module => module.CircleStackIcon),
    LightBulbIcon: () => import('@heroicons/vue/24/outline').then(module => module.LightBulbIcon),
    Bars3Icon: () => import('@heroicons/vue/24/outline').then(module => module.Bars3Icon),
    BellIcon: () => import('@heroicons/vue/24/outline').then(module => module.BellIcon),
    XMarkIcon: () => import('@heroicons/vue/24/outline').then(module => module.XMarkIcon),
    ExternalFooter: () => import('../components/External/ExternalFooter.vue'),
    Popover: () => import('@headlessui/vue').then(module => module.Popover),
    PopoverButton: () => import('@headlessui/vue').then(module => module.PopoverButton),
    PopoverPanel: () => import('@headlessui/vue').then(module => module.PopoverPanel),
    PopoverOverlay: () => import('@headlessui/vue').then(module => module.PopoverOverlay),
    Disclosure: () => import('@headlessui/vue').then(module => module.Disclosure),
    DisclosureButton: () => import('@headlessui/vue').then(module => module.DisclosureButton),
    DisclosurePanel: () => import('@headlessui/vue').then(module => module.DisclosurePanel),
    Menu: () => import('@headlessui/vue').then(module => module.Menu),
    MenuButton: () => import('@headlessui/vue').then(module => module.MenuButton),
    MenuItem: () => import('@headlessui/vue').then(module => module.MenuItem),
    MenuItems: () => import('@headlessui/vue').then(module => module.MenuItems),
  },
  data() {
    return {
      // ...
    };
  },
  mounted() {
    // ...
  },
  methods: {
    // ...
  },
};
```

Make sure to replace the regular import statements with the dynamic import statements as shown above.

---

## User

now convert this


<script>
import {
  InboxIcon,
  PencilIcon,
  TrashIcon,
  UsersIcon,
} from '@heroicons/vue/24/outline';
import JovieReplaces from '../components/External/JovieReplaces.vue';
import UserService from '../services/api/user.service';
import HomeLogoCloud from '../components/Home/HomeLogoCloud.vue';
import HomeFeatureSequences from '../components/Home/HomeFeatureSequences.vue';
import HomeFeatureDiscovery from '../components/Home/HomeFeatureDiscovery.vue';
import HomeHeroSection from '../components/Home/HomeHeroSection.vue';
import HomeCTA from '../components/Home/HomeCTA.vue';
import HomeTestimonials from '../components/Home/HomeTestimonials.vue';
import HomeCTA4 from '../components/Home/HomeCTA4.vue';
import HomeFeatureCRM from '../components/Home/HomeFeatureCRM.vue';
import HomeCreatorSearch from '../components/Home/HomeCreatorSearch.vue';
import Enrichment from '../components/Enrichment.vue';
import SocialIcons from '../components/SocialIcons.vue';
import JovieLogo from '../components/JovieLogo.vue';

import CallToAction from '../components/CallToAction.vue';

import ButtonGroup from '@/components/ButtonGroup.vue';
export default {
  name: 'Home',
  components: {
    HomeLogoCloud

    JovieLogo,
    HomeFeatureSequences,
    HomeCreatorSearch,
    HomeFeatureDiscovery,
    Enrichment,
    HomeHeroSection,
    HomeCTA,
    ButtonGroup,
    HomeTestimonials,
    CallToAction,
    HomeCTA4,
    HomeFeatureCRM,
    JovieReplaces,
    SocialIcons,
  },
  data() {
    return {
      waitListEmail: '',
      error: null,
      loading: false,
      icons: [
        {
          id: 1,
          name: 'twitter',
          fillColor: '#1DA1F2',
        },
        {
          id: 2,
          name: 'twitch',
          fillColor: '#9146FF',
        },
        {
          id: 3,
          name: 'youtube',
          fillColor: '#FF0000',
        },
        {
          id: 4,
          name: 'instagram',
          fillColor: '#E1306C',
        },
        {
          id: 5,
          name: 'tiktok',
          fillColor: '#000000',
        },
      ],
      features: [
        {
          id: 1,
          header: 'Save Contacts from any Social Media Profile',
          subheader:
            ' Never type contact info again.  Jovie let’s you import any Tiktok, Twitter, Instagram, or Twitch profile instantly.',
          cta: 'Download Chrome Extension',
          ctaLink:
            'https://chrome.google.com/webstore/detail/jovie-the-social-crm/daeopelnocmnhbkjbjmhckgjgheioafj',
          img: 'img/External/Marketing/Chrome/Jovie_Chrome_Extension_Screenshot.png',
        },
        {
          id: 2,
          header: 'Organize everyone in one place',
          subheader:
            'Jovie works like the tools you love, letting you create lists and drag-n-drop contacts right into them. Leave notes for yourself or comments to share with your team.',
          img: 'img/External/Marketing/Chrome/Jovie_Lists_Screenshot.png',
        },
        {
          id: 3,
          header: 'Enrich contacts automatically',
          subheader:
            'No more manual data entry. No more incomplete records. Save a contact on instagram? Don’t worry, we have their twitter profile too. Jovie automatically enriches contacts with all their social media profiles & more.',
          img: 'img/External/Marketing/Chrome/Jovie_Enrichment_Screenshot.png',
          cta: 'Try Jovie free',

          ctaLink: 'https://jov.ie/signup',
        },
      ],
    };
  },
  mounted() {
    window.analytics.page('Home');
  },
  methods: {
    login() {
      // login();
    },
    logout() {
      // logout();
    },
    async identifyUser() {
      //segment identify call
      window.analytics.identify({
        email: this.waitListEmail,
      });
      //segment track call
      window.analytics.track('Initated Sign Up');
    },
    async requestDemo() {
      this.loading = true;

      await UserService.addToWaitList({
        email: this.waitListEmail,
        page: 'Home',
      })
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.$store.commit('setAddedToWaitList');
            this.waitListEmail = '';
            this.error = null;
            this.$router.push('signup');
          }
        })
        .catch((error) => {
          error = error.response;
          this.loading = false;
          if (error.status == 422) {
            this.error = error.data.errors.email[0];
          }
        });
    },
  },
};
</script>


---

## Assistant

Yes, in this case, you should remove the regular import statements and replace them with dynamic import statements as well. Here's the modified code:

```javascript
export default {
  name: 'Home',
  components: {
    HomeLogoCloud: () => import('../components/Home/HomeLogoCloud.vue'),
    JovieLogo: () => import('../components/JovieLogo.vue'),
    HomeFeatureSequences: () => import('../components/Home/HomeFeatureSequences.vue'),
    HomeCreatorSearch: () => import('../components/Home/HomeCreatorSearch.vue'),
    HomeFeatureDiscovery: () => import('../components/Home/HomeFeatureDiscovery.vue'),
    Enrichment: () => import('../components/Enrichment.vue'),
    HomeHeroSection: () => import('../components/Home/HomeHeroSection.vue'),
    HomeCTA: () => import('../components/Home/HomeCTA.vue'),
    ButtonGroup: () => import('@/components/ButtonGroup.vue'),
    HomeTestimonials: () => import('../components/Home/HomeTestimonials.vue'),
    CallToAction: () => import('../components/CallToAction.vue'),
    HomeCTA4: () => import('../components/Home/HomeCTA4.vue'),
    HomeFeatureCRM: () => import('../components/Home/HomeFeatureCRM.vue'),
    JovieReplaces: () => import('../components/External/JovieReplaces.vue'),
    SocialIcons: () => import('../components/SocialIcons.vue'),
  },
  data() {
    return {
      // ...
    };
  },
  mounted() {
    // ...
  },
  methods: {
    // ...
  },
};
```

Make sure to replace the regular import statements with the dynamic import statements as shown above.

---

## User


<script>
import {
  InboxIcon,
  PencilIcon,
  TrashIcon,
  UsersIcon,
} from '@heroicons/vue/24/outline';
import JovieReplaces from '../components/External/JovieReplaces.vue';
import UserService from '../services/api/user.service';
import HomeLogoCloud from '../components/Home/HomeLogoCloud.vue';
import HomeFeatureSequences from '../components/Home/HomeFeatureSequences.vue';
import HomeFeatureDiscovery from '../components/Home/HomeFeatureDiscovery.vue';
import HomeHeroSection from '../components/Home/HomeHeroSection.vue';
import HomeCTA from '../components/Home/HomeCTA.vue';
import HomeTestimonials from '../components/Home/HomeTestimonials.vue';
import HomeCTA4 from '../components/Home/HomeCTA4.vue';
import HomeFeatureCRM from '../components/Home/HomeFeatureCRM.vue';
import HomeCreatorSearch from '../components/Home/HomeCreatorSearch.vue';
import Enrichment from '../components/Enrichment.vue';
import SocialIcons from '../components/SocialIcons.vue';
import JovieLogo from '../components/JovieLogo.vue';

import CallToAction from '../components/CallToAction.vue';

import ButtonGroup from '@/components/ButtonGroup.vue';
export default {
  name: 'Home',
  components: {
    HomeLogoCloud

    JovieLogo,
    HomeFeatureSequences,
    HomeCreatorSearch,
    HomeFeatureDiscovery,
    Enrichment,
    HomeHeroSection,
    HomeCTA,
    ButtonGroup,
    HomeTestimonials,
    CallToAction,
    HomeCTA4,
    HomeFeatureCRM,
    JovieReplaces,
    SocialIcons,
  },
  data() {
    return {
      waitListEmail: '',
      error: null,
      loading: false,
      icons: [
        {
          id: 1,
          name: 'twitter',
          fillColor: '#1DA1F2',
        },
        {
          id: 2,
          name: 'twitch',
          fillColor: '#9146FF',
        },
        {
          id: 3,
          name: 'youtube',
          fillColor: '#FF0000',
        },
        {
          id: 4,
          name: 'instagram',
          fillColor: '#E1306C',
        },
        {
          id: 5,
          name: 'tiktok',
          fillColor: '#000000',
        },
      ],
      features: [
        {
          id: 1,
          header: 'Save Contacts from any Social Media Profile',
          subheader:
            ' Never type contact info again.  Jovie let’s you import any Tiktok, Twitter, Instagram, or Twitch profile instantly.',
          cta: 'Download Chrome Extension',
          ctaLink:
            'https://chrome.google.com/webstore/detail/jovie-the-social-crm/daeopelnocmnhbkjbjmhckgjgheioafj',
          img: 'img/External/Marketing/Chrome/Jovie_Chrome_Extension_Screenshot.png',
        },
        {
          id: 2,
          header: 'Organize everyone in one place',
          subheader:
            'Jovie works like the tools you love, letting you create lists and drag-n-drop contacts right into them. Leave notes for yourself or comments to share with your team.',
          img: 'img/External/Marketing/Chrome/Jovie_Lists_Screenshot.png',
        },
        {
          id: 3,
          header: 'Enrich contacts automatically',
          subheader:
            'No more manual data entry. No more incomplete records. Save a contact on instagram? Don’t worry, we have their twitter profile too. Jovie automatically enriches contacts with all their social media profiles & more.',
          img: 'img/External/Marketing/Chrome/Jovie_Enrichment_Screenshot.png',
          cta: 'Try Jovie free',

          ctaLink: 'https://jov.ie/signup',
        },
      ],
    };
  },
  mounted() {
    window.analytics.page('Home');
  },
  methods: {
    login() {
      // login();
    },
    logout() {
      // logout();
    },
    async identifyUser() {
      //segment identify call
      window.analytics.identify({
        email: this.waitListEmail,
      });
      //segment track call
      window.analytics.track('Initated Sign Up');
    },
    async requestDemo() {
      this.loading = true;

      await UserService.addToWaitList({
        email: this.waitListEmail,
        page: 'Home',
      })
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.$store.commit('setAddedToWaitList');
            this.waitListEmail = '';
            this.error = null;
            this.$router.push('signup');
          }
        })
        .catch((error) => {
          error = error.response;
          this.loading = false;
          if (error.status == 422) {
            this.error = error.data.errors.email[0];
          }
        });
    },
  },
};
</script>


---

## Assistant

Here's the modified code with dynamic imports:

```javascript
export default {
  name: 'Home',
  components: {
    HomeLogoCloud: () => import('../components/Home/HomeLogoCloud.vue'),
    JovieLogo: () => import('../components/JovieLogo.vue'),
    HomeFeatureSequences: () => import('../components/Home/HomeFeatureSequences.vue'),
    HomeCreatorSearch: () => import('../components/Home/HomeCreatorSearch.vue'),
    HomeFeatureDiscovery: () => import('../components/Home/HomeFeatureDiscovery.vue'),
    Enrichment: () => import('../components/Enrichment.vue'),
    HomeHeroSection: () => import('../components/Home/HomeHeroSection.vue'),
    HomeCTA: () => import('../components/Home/HomeCTA.vue'),
    ButtonGroup: () => import('@/components/ButtonGroup.vue'),
    HomeTestimonials: () => import('../components/Home/HomeTestimonials.vue'),
    CallToAction: () => import('../components/CallToAction.vue'),
    HomeCTA4: () => import('../components/Home/HomeCTA4.vue'),
    HomeFeatureCRM: () => import('../components/Home/HomeFeatureCRM.vue'),
    JovieReplaces: () => import('../components/External/JovieReplaces.vue'),
    SocialIcons: () => import('../components/SocialIcons.vue'),
  },
  data() {
    return {
      waitListEmail: '',
      error: null,
      loading: false,
      icons: [
        {
          id: 1,
          name: 'twitter',
          fillColor: '#1DA1F2',
        },
        {
          id: 2,
          name: 'twitch',
          fillColor: '#9146FF',
        },
        {
          id: 3,
          name: 'youtube',
          fillColor: '#FF0000',
        },
        {
          id: 4,
          name: 'instagram',
          fillColor: '#E1306C',
        },
        {
          id: 5,
          name: 'tiktok',
          fillColor: '#000000',
        },
      ],
      features: [
        {
          id: 1,
          header: 'Save Contacts from any Social Media Profile',
          subheader: 'Never type contact info again. Jovie let’s you import any Tiktok, Twitter, Instagram, or Twitch profile instantly.',
          cta: 'Download Chrome Extension',
          ctaLink: 'https://chrome.google.com/webstore/detail/jovie-the-social-crm/daeopelnocmnhbkjbjmhckgjgheioafj',
          img: 'img/External/Marketing/Chrome/Jovie_Chrome_Extension_Screenshot.png',
        },
        {
          id: 2,
          header: 'Organize everyone in one place',
          subheader: 'Jovie works like the tools you love, letting you create lists and drag-n-drop contacts right into them. Leave notes for yourself or comments to share with your team.',
          img: 'img/External/Marketing/Chrome/Jovie_Lists_Screenshot.png',
        },
        {
          id: 3,
          header: 'Enrich contacts automatically',
          subheader: 'No more manual data entry. No more incomplete records. Save a contact on Instagram? Don’t worry, we have their Twitter profile too. Jovie automatically enriches contacts with all their social media profiles & more.',
          img: 'img/External/Marketing/Chrome/Jovie_Enrichment_Screenshot.png',
          cta: 'Try Jovie free',
          ctaLink: 'https://jov.ie/signup',
        },
      ],
    };
  },
  mounted() {
    window.analytics.page('Home');
  },
  methods: {
    login() {
      //


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_vuejs-component-overview-2]]
- [[chatgpt/chatgpt_add-prop-to-vuejs-component]]
- [[chatgpt/chatgpt_modify-vuejs-component-for-arrow-key-navigation]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part1]]
- [[chatgpt/chatgpt_optimize-vuejs-component-part2]]

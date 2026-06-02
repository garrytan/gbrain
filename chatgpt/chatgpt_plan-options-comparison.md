---
title: "Plan options comparison."
type: guide
created: 2023-03-03
updated: 2023-03-03
source: chatgpt-export
conversation_id: 9dc042d6-4f73-4e52-862d-7be1455a9560
message_count: 2
tags: [chatgpt, import, code]
---
# Plan options comparison.

> Conversation ID: 9dc042d6-4f73-4e52-862d-7be1455a9560
> Created: 2023-03-03T04:57:25Z
> Updated: 2023-03-03T04:57:25Z
> Messages: 2

---

## User

const tiers = [
  {
    name: 'Freelancer',
    id: 'tier-freelancer',
    href: '#',
    price: { monthly: '$15', annually: '$144' },
    description: 'The essentials to provide your best work for clients.',
    features: [
      '5 products',
      'Up to 1,000 subscribers',
      'Basic analytics',
      '48-hour support response time',
    ],
    featured: false,
    cta: 'Buy plan',
  },
  {
    name: 'Startup',
    id: 'tier-startup',
    href: '#',
    price: { monthly: '$30', annually: '$288' },
    description: 'A plan that scales with your rapidly growing business.',
    features: [
      '25 products',
      'Up to 10,000 subscribers',
      'Advanced analytics',
      '24-hour support response time',
      'Marketing automations',
    ],
    featured: false,
    cta: 'Buy plan',
  },
  {
    name: 'Enterprise',
    id: 'tier-enterprise',
    href: '#',
    price: 'Custom',
    description: 'Dedicated support and infrastructure for your company.',
    features: [
      'Unlimited products',
      'Unlimited subscribers',
      'Advanced analytics',
      '1-hour, dedicated support response time',
      'Marketing automations',
      'Custom reporting tools',
    ],
    featured: true,
    cta: 'Contact sales',
  },
];


i need to put the code below into the format of the above. 


const tiers = [
  {
    name: 'Pro',
    href: 'signup',
    color: 'pink',
    featured: false,
    priceMonthly: 10,
    priceAnnual: 96,
    description: 'For freelancers',
    features: [
      { name: '500 Contacts', icon: 'UserGroupIcon' },

      { name: '50 Jovie AI Credits', icon: 'SparklesIcon' },

      { name: 'Unlimited lists', icon: 'ListBulletIcon' },
      { name: '1 User', icon: 'UserIcon' },
      {
        name: 'Use of the Jovie Chrome Extension',
        icon: 'GlobeEuropeAfricaIcon',
      },
      { name: 'Email support', icon: 'LifebuoyIcon' },

      { name: 'Blazing fast CRM Search', icon: 'BoltIcon' },
    ],
  },
  {
    name: 'Team',
    color: 'sky',
    href: 'signup',
    featured: true,
    priceMonthly: 24,
    priceAnnual: 192,
    description: 'Built for startups and growing teams',
    features: [
      { name: 'Unlimited Contacts', icon: 'UserGroupIcon' },
      { name: '100 Jovie AI Credits', icon: 'SparklesIcon' },
      { name: 'Unlimited lists', icon: 'ListBulletIcon' },
      { name: 'Up to 50 users', icon: 'UsersIcon' },
      {
        name: 'Use of the Jovie Chrome Extension',
        icon: 'GlobeEuropeAfricaIcon',
      },
      { name: 'Blazing fast search', icon: 'BoltIcon' },
      { name: 'Unlimited CSV exports', icon: 'CloudArrowDownIcon' },
      {
        name: 'Collaboration & team managment',
        icon: 'ChatBubbleBottomCenterIcon',
      },
    ],
  },
  {
    name: 'Enterprise',
    href: 'request-demo',
    color: 'violet',
    featured: false,
    priceMonthly: 'Annual Only',
    priceAnnual: 468,
    description: 'For large teams and enterprises',
    features: [
      /*  {
        name: `Prospecting engine - Search ${store.state.creatorsDBCount}+ social media profiles`,
        icon: 'CircleStackIcon',
      }, */
      { name: 'Unlimited Contacts', icon: 'UserGroupIcon' },
      { name: '500 Jovie AI Credits', icon: 'SparklesIcon' },
      { name: 'Unlimited lists', icon: 'ListBulletIcon' },
      { name: 'Unlimited users', icon: 'UsersIcon' },
      {
        name: 'Use of the Jovie Chrome Extension',
        icon: 'GlobeEuropeAfricaIcon',
      },
      { name: 'Blazing fast search', icon: 'BoltIcon' },
      { name: 'Unlimited CSV exports', icon: 'CloudArrowDownIcon' },
      {
        name: 'Collaboration & team managment',
        icon: 'ChatBubbleBottomCenterIcon',
      },
      {
        name: `Prospecting engine - Search millions of social media profiles`,
        icon: 'CircleStackIcon',
      },
      { name: 'Dedicated support', icon: 'PhoneIcon' },
    ],
  },
];

---

## Assistant

Here's the code formatted into the structure of the original `tiers` array:

```
const tiers = [
  {
    name: 'Pro',
    id: 'tier-pro',
    href: 'signup',
    price: { monthly: '$10', annually: '$96' },
    description: 'For freelancers',
    features: [
      '500 Contacts',
      '50 Jovie AI Credits',
      'Unlimited lists',
      '1 User',
      'Use of the Jovie Chrome Extension',
      'Email support',
      'Blazing fast CRM Search',
    ],
    featured: false,
    cta: 'Buy plan',
  },
  {
    name: 'Team',
    id: 'tier-team',
    href: 'signup',
    price: { monthly: '$24', annually: '$192' },
    description: 'Built for startups and growing teams',
    features: [
      'Unlimited Contacts',
      '100 Jovie AI Credits',
      'Unlimited lists',
      'Up to 50 users',
      'Use of the Jovie Chrome Extension',
      'Blazing fast search',
      'Unlimited CSV exports',
      'Collaboration & team managment',
    ],
    featured: true,
    cta: 'Buy plan',
  },
  {
    name: 'Enterprise',
    id: 'tier-enterprise',
    href: 'request-demo',
    price: { monthly: 'Annual Only', annually: '$468' },
    description: 'For large teams and enterprises',
    features: [
      'Unlimited Contacts',
      '500 Jovie AI Credits',
      'Unlimited lists',
      'Unlimited users',
      'Use of the Jovie Chrome Extension',
      'Blazing fast search',
      'Unlimited CSV exports',
      'Collaboration & team managment',
      'Prospecting engine - Search millions of social media profiles',
      'Dedicated support',
    ],
    featured: false,
    cta: 'Contact sales',
  },
];
``` 

Note that the `color` property from the original code has not been included in the new format, as it was not used in the original `tiers` array. If you need this property, you can add it to the new code as appropriate.

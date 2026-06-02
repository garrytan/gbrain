---
title: "Configurações do aplicativo de treinamento"
type: essay
created: 2024-02-09
updated: 2024-02-09
source: chatgpt-export
conversation_id: dcd3f69f-540a-419e-95a8-6b3037feaf88
message_count: 16
tags: [chatgpt, import, long-form]
---
# Configurações do aplicativo de treinamento

> Conversation ID: dcd3f69f-540a-419e-95a8-6b3037feaf88
> Created: 2024-02-09T22:15:51Z
> Updated: 2024-02-09T22:24:09Z
> Messages: 16


import resolveConfig from 'tailwindcss/resolveConfig';

import {EXERCISE_TYPE, UNIT} from '../../../lib/training.mjs';
import packageJson from '../package.json';
import tailwindConfig from '../tailwind.config.js';

const fullConfig = resolveConfig(tailwindConfig);
export const BREAKPOINTS = fullConfig?.theme?.screens;

export const APP_VERSION = packageJson.version;

export let ENV = RP_ENV || NODE_ENV;

export let API_URL = '/api';
if (RP_API_BASE_URL) {
  API_URL = RP_API_BASE_URL;
}

export const EVENTS_URL = `${API_URL}/events`;

export let AUTH_URL = 'https://apps.rpstrength.com';
if (RP_AUTH_URL) {
  AUTH_URL = RP_AUTH_URL;
} else {
  switch (ENV) {
    case 'production':
      AUTH_URL = 'https://apps.rpstrength.com';
      break;
    case 'development':
      AUTH_URL = 'https://apps.dev.rpstrength.com';
      break;
    case 'local':
      AUTH_URL = 'http://localhost:3000';
      break;
    default:
      AUTH_URL = `https://apps.${ENV}.rpstrength.app`;
      break;
  }
}

export const ACCESS_ITEM = {
  training: 'training',
  diet: 'diet',
};

export const COOKIE_KEY = 'rp_token';

export const ROOT_DOMAIN = location.hostname.split('.').slice(1).join('.');

export const IS_HOST_LOCAL = location.hostname === 'localhost';

export const MAX_EXERCISES_PER_DAY = 8;

const muscleGroupNamesById = {
  1: 'chest',
  2: 'back',
  3: 'triceps',
  4: 'biceps',
  5: 'shoulders',
  6: 'quads',
  7: 'glutes',
  8: 'hamstrings',
  9: 'calves',
  10: 'traps',
  11: 'forearms',
  12: 'abs',
};

const pronounByMuscleGroupId = {
  1: 'it',
  2: 'it',
  3: 'them',
  4: 'them',
  5: 'them',
  6: 'them',
  7: 'them',
  8: 'them',
  9: 'them',
  10: 'them',
  11: 'them',
  12: 'them',
};

export const exerciseJointPainFeedbackText = exerciseName => {
  return {
    prompt: `How did your joints feel during ${exerciseName}?`,
    short: {
      0: 'None',
      1: 'Low pain',
      2: 'Moderate pain',
      3: 'A lot of pain',
    },
    long: {
      0: 'My joints felt great, no problems.',
      1: 'My joints felt ok, but I can definitely feel them being loaded.',
      2: "My joints are taking a bit of a beating. They definitely don't love this exercise right now.",
      3: 'My joints hurt BAD, something is up.',
    },
  };
};

export const muscleGroupFeedbackText = muscleGroupId => {
  const muscleGroupName = muscleGroupNamesById[muscleGroupId];
  const pronoun = pronounByMuscleGroupId[muscleGroupId];

  return {
    soreness: {
      prompt: `How sore did you get in your ${muscleGroupName} AFTER training ${pronoun} LAST TIME?`,
      short: {
        0: 'Never got sore',
        1: 'Healed a while ago',
        2: 'Healed just on time',
        3: "I'm still sore!",
      },
      long: {
        0: `I never got sore at all in my ${muscleGroupName} last time I trained ${pronoun}, and I could have trained ${pronoun} hard the next day! I'm ready to smash!`,
        1: `I got a tiny bit sore in my ${muscleGroupName} last time, but healed way before this session. I feel strong!`,
        2: 'I recovered just on time for this session and my target muscles feel good.',
        3: `I'm still sore, fatigued, or weak in my ${muscleGroupName} from the last time it trained it`,
      },
    },
    pump: {
      prompt: `How much of a pump did you get today in your ${muscleGroupName}?`,
      short: {
        0: 'Low pump',
        1: 'Moderate pump',
        2: 'Amazing pump',
      },
      long: {
        0: 'My pump was hardly noticeable or nonexistent.',
        1: 'My pump was ok. Definitely pumped, but nothing crazy.',
        2: 'My pump was amazing!',
      },
    },
    workload: {
      prompt: `How would you rate the difficulty of the work you did for your ${muscleGroupName}?`,
      short: {
        0: 'Easy',
        1: 'Pretty good',
        2: 'Pushed my limits',
        3: 'Too much',
      },
      long: {
        0: 'It felt like barely any work. I can do more and I have the time to do more.',
        1: 'It was a bit on the easy side, but it did hit the spot. I have the time to do more if needed, but only if that will get me better gains.',
        2: "It was quite a bit of work, and though I can do more, I'd prefer no more sets next time unless absolutely necessary.",
        3: "It was a ton of work, and I don't think I can do any more sets than this next time.",
      },
    },
  };
};

export const exerciseTypeNamesById = {
  [EXERCISE_TYPE.machine]: 'machine',
  [EXERCISE_TYPE.machineAssistance]: 'machine assistance',
  [EXERCISE_TYPE.barbell]: 'barbell',
  [EXERCISE_TYPE.dumbbell]: 'dumbbell',
  [EXERCISE_TYPE.cable]: 'cable',
  [EXERCISE_TYPE.freemotion]: 'freemotion',
  [EXERCISE_TYPE.smithMachine]: 'smith machine',
  [EXERCISE_TYPE.bodyweightOnly]: 'bodyweight',
  [EXERCISE_TYPE.bodyweightLoadable]: 'bodyweight loadable',
};

export const UNIT_DISPLAY = {
  singular: {
    [UNIT.lb]: 'lb',
    [UNIT.kg]: 'kg',
  },
  plural: {
    [UNIT.lb]: 'lbs',
    [UNIT.kg]: 'kg',
  },
};

// Available tailwind durations
const ANIMATION_DURATIONS = [0, 75, 100, 150, 200, 300, 500, 700, 1000];
export const ANIMATION_DURATION = ANIMATION_DURATIONS[4];

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const templateDayRecommendations = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};

export const feedbackTypes = {
  jointPain: 'jointPain',
  soreness: 'soreness',
  pump: 'pump',
  workload: 'workload',
};

export const feedbackTypeNames = {
  jointPain: 'joint pain',
  soreness: 'soreness',
  pump: 'pump',
  workload: 'workload',
};

export const LS_KEY_APP_VERSIONS = 'trainingWebVersionsSeen';
export const LS_KEY_APP_WELCOME_SEEN = 'trainingWebWelcomeSeen';
export const LS_KEY_APP_PWA_SEEN = 'trainingWebPWASeen';
export const LS_KEY_USER_SUBS = 'trainingUserSubs';
export const LS_KEY_EDIT_MESO_CREATION = 'trainingEditMesoCreate';
export const LS_KEY_EDIT_TEMPLATE_CREATION = 'trainingEditTemplateCreate';
export const LS_KEY_HAS_SEEN_CALENDAR = 'trainingHasSeenCalendar';
export const LS_KEY_THEME = 'trainingTheme';
export const LS_KEY_MASQUERADE = 'trainingWebMasquerade';
export const LS_KEY_WORKOUT_TUTORIAL_SEEN = 'trainingWebWorkoutTutorialSeen';
export const LS_KEY_WARMUP_INFO_SEEN = 'trainingWarmupInfoSeen';
export const LS_KEY_REST_INFO_SEEN = 'trainingRestInfoSeen';

export const DISPLAY_MODE_PWA = 'PWA';
export const DISPLAY_MODE_IN_BROWSER = 'in-browser';

export const MOBILE_HEADER_PORTAL_NODE = 'mobile-header-portal-node';

export const DISPLAY_MODE = window.matchMedia('(display-mode: standalone)').matches
  ? DISPLAY_MODE_PWA
  : DISPLAY_MODE_IN_BROWSER;

export const DIALOG_CONFIGS = {
  dayCompleteWarning: {
    description:
      "This workout has already been completed. You can make this change but it won't update any recommendations that have already been made for future workouts.",
  },
  resetBoard: {
    title: 'Reset board?',
    variant: 'error',
    message: 'This cannot be undone',
    description:
      'This will remove all muscle groups and reset your board to the initial blank state.',
    confirmButtonText: 'Reset board',
  },
};

export const MANIFEST_HREF_NORMAL = '/app.webmanifest';

export const SIDEBAR_WIDTH = 280; // pixels

export const THEMES = {
  light: 'light',
  dark: 'dark',
};

// As calculated by the rendered style of a list item not controlled by a <List /> component
export const LIST_ITEM_HEIGHT = 92;



This script is a JavaScript module that appears to be part of a web application, likely related to fitness or training, considering references to RP Strength (RP_ENV, RP_API_BASE_URL, etc.). It includes imports, constants, and configuration for various aspects of the application, such as API URLs, authentication URLs, app version, environment variables, exercise types, units of measurement, feedback mechanisms, and UI elements like animation durations and themes. The script is structured to provide modular, reusable configurations and utilities for different parts of the application, including handling user feedback on exercise impact (e.g., joint pain, muscle soreness), defining workout intensities, managing user authentication and environment settings, and supporting responsive design through breakpoints defined in the Tailwind CSS framework.


what lnaguage is it


The language used in the provided script is JavaScript, specifically utilizing ES6 (ECMAScript 2015) syntax and features such as `import` statements for modules, `const` and `let` for declaring variables, template literals, and arrow functions. This script is designed to be part of a modern web application, integrating with CSS frameworks like TailwindCSS and possibly a frontend framework or library.


import {StrictMode} from 'react';
import ReactDOM from 'react-dom/client';

import App from './App.jsx';
import {NotifierProvider} from './NotifierContext.jsx';

const root = document.getElementById('root');
if (!root) {
  throw new Error("The element #root wasn't found");
}

ReactDOM.createRoot(root).render(
  // 🤢🤢🤢 🤮🤮🤮
  <StrictMode>
    <NotifierProvider>
      <App />
    </NotifierProvider>
  </StrictMode>
);



The provided code snippet is written in JSX, a syntax extension for JavaScript commonly used with React, a popular JavaScript library for building user interfaces. This code snippet demonstrates how to bootstrap a React application with strict mode enabled, incorporating a context provider, presumably for managing notifications within the app. Here's a breakdown of what each part of the snippet does:

1. **Import Statements**:
   - `StrictMode` is imported from the `react` package. `StrictMode` is a tool for highlighting potential problems in an application. It does not render any visible UI but activates additional checks and warnings for its descendants.
   - `ReactDOM` is imported from `react-dom/client`, which provides DOM-specific methods that can be used at the top level of a web app to enable efficient management of DOM elements.
   - `App` is imported from `./App.jsx`, likely the main component of the application.
   - `NotifierProvider` is imported from `./NotifierContext.jsx`, which suggests it's a context provider component designed to manage and distribute notification-related data across the app.

2. **Root Element Retrieval**:
   The code retrieves an HTML element with the ID of `root`. This is a common pattern in React applications, where the app is mounted into a single root DOM node.

3. **Error Handling**:
   It includes a simple error handling mechanism that throws an error if the `#root` element is not found in the document. This ensures the application doesn't attempt to render without a valid mount point.

4. **React Application Rendering**:
   - `ReactDOM.createRoot(root).render()` is the method used to initialize the root of the React application.
   - The application is wrapped in `<StrictMode>`, which helps identify unsafe lifecycles, legacy API usage, and other issues in development mode.
   - The `NotifierProvider` wraps the `<App />` component, indicating that it likely provides a notification context to the entire app, allowing any component within the app to access notification state and logic.

This code is a typical example of setting up a React application's entry point, emphasizing best practices like strict mode usage and centralized state management through context providers.

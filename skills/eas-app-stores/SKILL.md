---
name: eas-app-stores
description: EAS service (paid). Deploy Expo apps to the app stores with EAS - build and submit to the iOS App Store, Google Play Store, and TestFlight, configure eas.json build and submit profiles, manage app versions and build numbers, and publish App Store metadata and ASO. Use whenever the user wants to deploy, release, or ship an app to production or the app stores, is preparing a production build, running eas build or eas submit, shipping to TestFlight, bumping version or build numbers, or setting up store listing metadata. For deploying an Expo website or API routes, use the eas-hosting skill.
version: 1.0.0
license: MIT
---

# App Store Deployment

> **EAS service - costs apply.** This skill uses Expo Application Services (EAS), a paid product with free-tier limits. `eas build` and `eas submit` consume your plan's build minutes, and store submission requires paid Apple Developer and Google Play accounts. Review https://expo.dev/pricing before running cloud commands.

This skill covers building and releasing Expo apps to the iOS App Store, Google Play Store, and TestFlight using EAS (Expo Application Services). For deploying an Expo website or API routes to EAS Hosting, use the `eas-hosting` skill.

## References

Consult these resources as needed:

- ./references/workflows.md -- CI/CD workflows for automated store releases and PR previews
- ./references/testflight.md -- Submitting iOS builds to TestFlight for beta testing
- ./references/app-store-metadata.md -- Managing App Store metadata and ASO optimization
- ./references/play-store.md -- Submitting Android builds to Google Play Store
- ./references/ios-app-store.md -- iOS App Store submission and review process

## Quick Start

### Install EAS CLI

```bash
npm install -g eas-cli
eas login
```

### Initialize EAS

```bash
npx eas-cli@latest init
```

This creates `eas.json` with build profiles.

## Build Commands

### Production Builds

```bash
# iOS App Store build
npx eas-cli@latest build -p ios --profile production

# Android Play Store build
npx eas-cli@latest build -p android --profile production

# Both platforms
npx eas-cli@latest build --profile production
```

### Submit to Stores

```bash
# iOS: Build and submit to App Store Connect
npx eas-cli@latest build -p ios --profile production --submit

# Android: Build and submit to Play Store
npx eas-cli@latest build -p android --profile production --submit

# Shortcut for iOS TestFlight
npx testflight
```

## Web & API Route Hosting

Deploying an Expo website or Expo Router API routes to EAS Hosting (`npx expo export -p web` then `eas deploy`) is covered by the `eas-hosting` skill. This skill focuses on native app store releases.

## EAS Configuration

Standard `eas.json` for production deployments:

```json
{
  "cli": {
    "version": ">= 16.0.1",
    "appVersionSource": "remote"
  },
  "build": {
    "production": {
      "autoIncrement": true,
      "ios": {
        "resourceClass": "m-medium"
      }
    },
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "your@email.com",
        "ascAppId": "1234567890"
      },
      "android": {
        "serviceAccountKeyPath": "./google-service-account.json",
        "track": "internal"
      }
    }
  }
}
```

## Platform-Specific Guides

### iOS

- Use `npx testflight` for quick TestFlight submissions
- Configure Apple credentials via `eas credentials`
- See ./references/testflight.md for credential setup
- See ./references/ios-app-store.md for App Store submission

### Android

- Set up Google Play Console service account
- Configure tracks: internal → closed → open → production
- See ./references/play-store.md for detailed setup

## Automated Releases

EAS Workflows automate the build → submit → update pipeline for CI/CD. See ./references/workflows.md for store-release examples. To author or validate workflow YAML, use the `eas-workflows` skill - it works from the live workflow schema.

## Version Management

EAS manages version numbers automatically with `appVersionSource: "remote"`:

```bash
# Check current versions
eas build:version:get

# Manually set version
eas build:version:set -p ios --build-number 42
```

## Monitoring

```bash
# List recent builds
eas build:list

# Check build status
eas build:view

# View submission status
eas submit:list
```


## Contract

This skill guarantees:

- Covers its source domain per the skill description: EAS service (paid). Deploy Expo apps to the app stores with EAS - build and submit to the iOS App Store, Google Play Store, and TestFlight, configure eas.json build and submit profiles, manage app versions and build numbers, and publish App Store metadata and 
- Loads only task-relevant references/scripts and keeps context lean.
- Produces concrete, source-grounded output: exact commands, code snippets, app configuration, token values, or platform steps as applicable.
- Never fabricates APIs, configuration keys, UI tokens, store metadata, or platform behavior not present in the source references or current project.

## Output Format

Lead with the actionable result. For implementation tasks, return the changed files/commands and verification result. For design/mobile guidance, return concise token/component/platform steps grounded in the skill references. Avoid dumping complete reference files; cite the relevant path and extract only the decisive snippet.

## Anti-Patterns

- Inventing APIs, store metadata, UI tokens, or platform capabilities.
- Copying large references into the response when a targeted excerpt is enough.
- Applying this skill outside its domain when a more specific skill exists.
- Skipping verification commands or platform checks after making changes.

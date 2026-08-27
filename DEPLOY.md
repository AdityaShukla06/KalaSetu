# Deploying KalaSetu

## One time setup

1. Install Node dependencies if you have not already: `npm install`
2. Log in to Firebase (opens a browser for Google sign in): `npx firebase-tools login`
3. Link this folder to a Firebase project: `npx firebase-tools use --add`
   Pick or create a project, then pick an alias (`default` is fine). This writes `.firebaserc`, which is committed so the whole team deploys to the same project.

## Deploy

```
npm run deploy
```

This runs `npm run build` (type check + production Vite build into `dist/`) then `firebase deploy --only hosting`. `firebase.json` points hosting at `dist` and rewrites every route to `index.html`, so client side routing (`/add-product/photo`, `/profile`, etc) keeps working on a hard refresh instead of 404ing.

After a successful deploy, the CLI prints the live URL, it looks like `https://<project-id>.web.app`. Write that URL down somewhere the whole team can see it, camera and microphone permissions require a secure context (HTTPS or localhost), so a teammate testing on their own phone needs this live URL, not a local IP address.

## Environment variables

`VITE_API_BASE_URL` is intentionally unset in production right now, there is no real backend yet, so the deployed build runs on the same mock API stubs as local dev (see `src/services/api.ts`). Once real endpoints exist, set `VITE_API_BASE_URL` before running `npm run deploy`, no code changes needed. There is no separate Firebase client config to set, this project only uses Firebase for static hosting, not any Firebase SDK (auth, Firestore, etc).

## Re-deploying

Every `npm run deploy` overwrites the previous release. Firebase Hosting keeps release history, `npx firebase-tools hosting:clone` or the Firebase console can roll back to a previous release if a deploy breaks something right before a demo.

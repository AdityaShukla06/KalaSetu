# Device test checklist

Run this on a real Android phone, using the live deployed URL (see `DEPLOY.md`), not a local IP address. Camera and microphone permissions require a secure context, so this checklist cannot be completed against a local dev server over plain HTTP.

Fill in Pass/Fail and notes as you go. If something fails, note the issue and a plan to fix it before the demo rather than leaving it blank.

Before starting, confirm `https://<project-id>.web.app/api/health` returns `{"status":"ok"}`. If it does not, the frontend will look broken in ways that have nothing to do with the checklist below.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Login with OTP works | Not yet tested | |
| 2 | Language toggle works and persists | Not yet tested | |
| 3 | Camera capture works | Not yet tested | |
| 4 | Camera file-picker fallback works (deny camera permission once to test) | Not yet tested | |
| 5 | Voice recording works | Not yet tested | |
| 6 | Voice text fallback works (deny mic permission once to test) | Not yet tested | |
| 7 | Price suggestion works | Not yet tested | |
| 8 | Manual price override works | Not yet tested | |
| 9 | Publish succeeds and the product appears in My Shop | Not yet tested | |
| 10 | "Add to Home Screen" installs correctly | Not yet tested | |
| 11 | Installed app opens in standalone mode (no browser chrome) | Not yet tested | |
| 12 | Offline banner appears when connection is dropped | Not yet tested | |
| 13 | Full add-product flow (photo through publish) completed in under 2 minutes | Not yet tested | Time it with a stopwatch |
| 14 | Edit a product (price and description) saves and the grid updates | Not yet tested | |
| 15 | Delete a product asks for confirmation, then removes it from the grid | Not yet tested | |
| 16 | A published product is still there after a full app restart | Not yet tested | Confirms Firestore persistence, not just in-memory state |
| 17 | Enhanced photo is visibly cleaned up and correctly oriented | Not yet tested | Shoot one in portrait, phone photos carry an EXIF rotation flag |
| 18 | Voice transcription returns real text from a real recording | Not yet tested | The highest risk item, exercises the WAV conversion and the model call end to end |
| 19 | Mic denied, type in Hindi only, publish still succeeds | Not yet tested | This path used to dead end |
| 20 | Profile name and shop name save and survive a reload | Not yet tested | |

## Live URL

Not yet deployed. Fill in here once `npm run deploy` succeeds (see `DEPLOY.md`), and share this file or the URL with the rest of the team.

`https://<project-id>.web.app`

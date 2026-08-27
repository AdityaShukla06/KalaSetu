# Device test checklist

Run this on a real Android phone, using the live deployed URL (see `DEPLOY.md`), not a local IP address. Camera and microphone permissions require a secure context, so this checklist cannot be completed against a local dev server over plain HTTP.

Fill in Pass/Fail and notes as you go. If something fails, note the issue and a plan to fix it before the demo rather than leaving it blank.

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

## Live URL

Not yet deployed. Fill in here once `npm run deploy` succeeds (see `DEPLOY.md`), and share this file or the URL with the rest of the team.

`https://<project-id>.web.app`

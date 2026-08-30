# Contributing to KalaSetu

## Don't push directly to main

Create a branch and open a pull request instead, even for small changes. This keeps `main` always deployable and gives everyone a chance to see what changed before it lands.

## Workflow

1. Pull the latest `main` before starting: `git checkout main && git pull`
2. Create a branch off `main`, named for what it does:
   - `feature/short-description` for new functionality
   - `fix/short-description` for bug fixes
   - `chore/short-description` for config, docs, or cleanup
   - Example: `feature/pricing-currency-format`
3. Commit your changes on that branch with clear messages describing why, not just what.
4. Push the branch: `git push -u origin <branch-name>`
5. Open a pull request into `main` on GitHub. Describe what changed and how you tested it (which screens, English and Hindi, desktop and device if applicable).
6. Get at least one review before merging. Fix anything flagged rather than merging around it.
7. Merge the PR (prefer squash merge so `main`'s history stays one commit per feature), then delete the branch.

## Before opening a PR

- `npm run build` passes (type checks and production build)
- `npm run lint` is clean
- If you touched `functions/`, `npm run build` and `npm test` pass in there too
- CI runs all of the above on every pull request, but check locally first rather than using CI as your test runner
- You tested the change in both English and Hindi if it touches UI, layout differences show up more in Hindi due to longer text
- New user facing strings are added to both `en` and `hi` in `src/context/translations.ts`, not just one language
- No comments in committed files, and no em dashes anywhere (code, docs, commit messages), see existing files for the house style
- Commit messages follow `commit.md`'s rules, your own identity only, no AI or tool attribution

## Reporting bugs or gaps

If you find something broken or missing, add it to `remaining tasks.md` rather than letting it live only in a chat thread or someone's memory, so the whole team can see the current state of the project in one place.

# PR Watch

A local watcher for the GitHub pull requests and issues you're involved in. It polls GitHub every minute, sends desktop notifications when someone else does something, and serves a small board at http://localhost:8765 showing what needs you.

No server, no database, no GitHub app. It uses your `gh` login and keeps its state in a single JSON file.

## Requirements

- Node.js 24 or later (it runs the `.ts` files directly)
- [GitHub CLI](https://cli.github.com/), logged in: `gh auth login`
- For notifications (optional; without it the board still works):

| OS | Notifier | Click opens the PR |
|---|---|---|
| macOS | `brew install terminal-notifier` | yes |
| Linux | `notify-send` (package `libnotify-bin` / `libnotify`) | no |
| Windows | built-in PowerShell toast, nothing to install | no |

## Run

```sh
npm install      # only for typecheck; runtime has no dependencies
npm start        # → PR Watch on http://localhost:8765
```

On macOS, notifications may be blocked on first run. Run `open "$(brew --prefix terminal-notifier)/terminal-notifier.app"` once, then allow it under System Settings → Notifications.

## What it watches

It tracks every open item matching the GitHub search `is:open involves:@me`, plus tracked items that get merged or closed by someone else.

It turns these into events. Your own actions are ignored.

| Event | Source |
|---|---|
| Comments, reviews (approved / changes requested / commented / dismissed) | timeline |
| Commits, force pushes | timeline |
| Review requested from you | timeline |
| Merged, closed | timeline |
| CI turned success / failure / error | status snapshot, compared between polls |
| PR became conflicting | `mergeable` snapshot, compared between polls |

Any event newer than what you last marked done counts as unread.

## The board

There are two pages: **Pull requests** and **Issues** (`#issues`).

| Section | Meaning |
|---|---|
| **Needs you** | Has unread events. The card shows the most urgent one (changes requested, CI failed, merge conflict, review requested, …) and who did what. |
| **Waiting on others** | Your own open PR, nothing unread, not approved yet. |
| **Handled** | Nothing unread, nothing expected from you. |

Clicking **Done** on a card marks it read up to the newest event shown. Anything that arrives afterwards makes it unread again. Marking a merged or closed item done drops it completely.

**Work on it** on a card flags it as in progress. A flagged card stays in **Needs you** (sorted first, amber frame) even with nothing unread, until you click **Done**, which also clears the flag. The flag lives in `state.json`, so it survives restarts.

PR cards show their merge target in the top line: `→ main` for a normal PR, or `→ #1180` (linked) for a stacked PR whose base branch is another open PR's head. A PR that others are stacked on has its own number highlighted; hover it to see which PRs sit on it (only ones on your board).

Cards also carry state tags: Draft, Merged, Closed, Approved, Changes requested, Review required, Conflicts.

Your view settings (filters, layout, collapsed sections, theme) are saved per browser in `localStorage`.

## Behaviour notes

- **First run is silent.** The first poll only records a baseline. You get notified about changes after that.
- **Grouped notifications.** More than 3 notifications in one poll collapse into a single summary notification.
- **Snapshot events fire on transitions.** CI and merge-conflict events fire when the state *changes*. A PR that already had conflicts before prwatch saw it shows a `[Conflicts]` tag but no notification.
- **Limits.** It reads the first 100 search hits and the last 20 timeline items per item, and keeps at most 30 events per item.
- **Refresh.** The UI re-reads local state every 15 s. The refresh button forces a GitHub poll.

## Files

| Path | What |
|---|---|
| `src/main.ts` | Poll loop, state file, per-OS notifications, HTTP server (binds 127.0.0.1 only) |
| `src/github.ts` | GraphQL queries via `fetch`, using the token from `gh auth token` |
| `src/events.ts` | Pure logic: GitHub data → items/events, unread tracking, notifications |
| `public/index.html` | The whole UI, no build step |
| `test/events.test.ts` | Tests for `events.ts` |
| `~/.prwatch/state.json` | Tracked items and read watermarks. Delete it to start fresh. |

## Develop

```sh
npm test           # node --test
npm run typecheck  # tsc
```

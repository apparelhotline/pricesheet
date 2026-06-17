# Cowork — Claude Code session companion (iOS PWA)

A mobile web app that **mirrors your Claude Code "cowork" sessions and lets you chat with them** —
installable on your iPhone home screen, no App Store or Xcode required.

Live URL (after deploy): **https://apparelhotline.github.io/pricesheet/cowork.html**

## Why a PWA (and not a native Swift app)

There is **no public API** to plug a third‑party native app directly into the live message stream of
official `claude.ai/code` web sessions — the official mobile experience is the responsive web app +
the Claude iOS app. A native Swift app would need a Mac + Xcode + an Apple Developer account and would
still hit that same wall.

What *is* official and accessible is **GitHub**. Every cowork web session works on your repo through
`claude/*` branches and draft PRs, and supports **PR‑activity subscriptions** — when you comment on a
session's PR, the session wakes up and responds. So this app uses GitHub as the real bridge:

- **Mirror** → reads your `claude/*` branches, their PRs, latest commits, and CI status.
- **Two‑way chat** → posting a message adds a **comment on the session's PR**; a watching session
  picks it up and replies, and its reply shows up here on the next refresh.

That gives you genuine two‑way chat with your sessions from your phone, today, with zero backend.

## Install on iPhone

1. Open **https://apparelhotline.github.io/pricesheet/cowork.html** in **Safari**.
2. Tap the **Share** button → **Add to Home Screen**.
3. Launch "Cowork" from the home screen — it runs full‑screen like a native app.

## First‑run setup

Open the **Settings** tab:

1. Tap **⌘ Connect with GitHub** — this opens GitHub's token page with the `repo` scope and a
   name (`Cowork PWA (owner/repo)`) already filled in.
2. Tap **Generate token**, then **Copy** it.
3. Back in the app, tap **Paste** next to the token field — it reads the token from your clipboard
   and connects automatically. (If the browser blocks clipboard access, paste into the field and tap
   **Save & connect**.)

Owner / Repository / branch‑prefix default to `apparelhotline` / `pricesheet` / `claude/` and can be
changed in the same screen.

### Why guided PAT and not OAuth "device flow"

A no‑paste OAuth device flow **cannot run from a static PWA**: GitHub's `login/device/code` and
`login/oauth/access_token` endpoints don't send CORS headers, so the browser blocks them — it would
require a backend/proxy to relay the token exchange. The guided PAT keeps the app fully static and
keeps your token on‑device, while making setup nearly one‑tap.

The token is stored only in this device's `localStorage`. Either a **classic PAT** with the `repo`
scope, or a **fine‑grained PAT** on your repo with **Contents: Read**, **Pull requests: Read & write**,
**Actions: Read**, works. Tap **Clear token** to remove it.

## Using it

- **Sessions tab** — one card per session (branch). Shows the latest commit, PR/draft state,
  CI status, and comment count. Auto‑refreshes every 30s.
- **Tap a session** — opens the chat: the PR description + all comments as a message thread.
  Type a message and send (⌘/Ctrl+Enter also sends) to post a PR comment back to the session.
- **Pull‑to‑refresh** via the ⟳ button in the header.

## Files

| File | Purpose |
|------|---------|
| `cowork.html` | The entire app (HTML/CSS/JS, no build step) |
| `manifest.webmanifest` | PWA manifest (install metadata) |
| `cowork-sw.js` | Service worker — caches the app shell; never caches GitHub API traffic |
| `assets/cowork-icon-*.png` | App icons (180/192/512) |
| `assets/make-cowork-icons.py` | Regenerates the icons (pure Python, no deps) |

## Security note

The GitHub token lives only in your browser's localStorage on the device. Use a token scoped to just
this repo, and tap **Clear token** in Settings to remove it. Because GitHub Pages is static, nothing is
ever sent to any server other than `api.github.com`.

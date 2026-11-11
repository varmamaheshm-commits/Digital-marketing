# Marketing Studio

A complete, self-contained digital marketing application. Add a product once and the
app prepares everything around it — videos, posts, emails, ad copy and lead follow-ups —
then waits for **your approval** before anything can be saved, shared or sent.

It runs entirely on your own device. There is no server, no account, no subscription
and no outside service: the app makes **zero** network connections.

## What it does

| Area | What happens automatically | What you decide |
| --- | --- | --- |
| **Products** | Photos are cleaned (location data removed) and stored encrypted | What to sell, price, offer, selling points |
| **Videos** | A script is written and a full-HD video is rendered with motion, animated titles, price badge, call-to-action and generated music — vertical 9:16 (Reels / Shorts), square 1:1 and widescreen 16:9 (YouTube) | Approve, reject, edit the script, or ask for a new version |
| **Content** | A week of posts is drafted and scheduled: Instagram, Facebook, YouTube, WhatsApp broadcast, email and ad copy, with hashtags | Approve / edit / reject each draft |
| **Leads** | Leads are scored, and welcome / follow-up / offer messages are drafted | Approve each message, then send it from your own WhatsApp, SMS or email |
| **Knowledge base** | Your price lists, FAQs and policies are indexed on the device; a customer question is matched to the right passages and a reply is drafted from them | What to add; edit the reply before sending |
| **Campaigns** | Click rate, cost per lead and return on spend are calculated | Budgets and recorded results |
| **Autopilot** | Re-checks every 10 minutes and tops up whatever is missing | On / off, how often, which video shapes |

**The approval rule:** every video waits as *needs approval*; Save and Share only appear after
you approve it. Posts and lead messages are approved automatically by default — switch
*Settings → Autopilot → What needs your approval* to *Everything* to review those too.

**Languages:** videos can be made in English, Hindi, Telugu and Tamil (fonts are bundled). The
fixed phrases (opening line, call-to-action, offer labels) are translated; the product name,
description and selling points appear exactly as you typed them.

## Install

Setup files are built automatically by the *Build installers* workflow (GitHub → **Actions**
→ latest run → **Artifacts**). Pushing a tag such as `v1.0.0` also attaches them to a Release.

| Device | File | How |
| --- | --- | --- |
| Windows PC | `Marketing-Studio-Setup-…-win-x64.exe` | Run the installer. Windows may show a "unknown publisher" notice because the file is not code-signed — choose *More info → Run anyway*. |
| Android phone / tablet | `Marketing-Studio-…-android.apk` | Open the file on the device and allow installing from this source. |
| Linux PC | `…-linux-x86_64.AppImage` | `chmod +x` the file and run it. |
| Mac | `…-mac-….dmg` | Built on tags / manual runs. Unsigned: right-click the app → *Open* the first time. |
| iPhone / iPad | — | Apple only allows installs through the App Store or a paid developer account. Until then, host the `dist/` folder on any HTTPS address and use Safari → *Share → Add to Home Screen*; it then works offline like an app. |

First start: choose a master password, then **write down the recovery key** that is shown once.

### Moving to another device

Each device keeps its own encrypted data. To move or copy it: *Settings → Backup & restore →
Save backup*, then *Restore from a backup file* on the other device. The backup stays encrypted.

## Security

- **Encryption at rest** — every record, photo and video is encrypted with AES-256-GCM.
  The key is derived from your master password (PBKDF2-SHA-256, 600,000 rounds) and is never stored.
- **Recovery key** — a one-time 147-bit key is the only other way in. Without the password or
  the recovery key the data cannot be read by anyone, including the developer.
- **Lockout** — after 5 wrong passwords the app locks for 30 seconds, doubling up to 15 minutes.
- **Auto-lock** after inactivity (2–60 minutes, default 10).
- **No network** — a strict content-security policy forbids outside connections; the desktop app
  additionally cancels every non-local request, runs the page sandboxed with no system access,
  and blocks navigation, pop-ups and device permissions.
- **Privacy** — follow-ups are only drafted for leads who agreed to be contacted; imported
  contacts are never assumed to have agreed. Exported spreadsheets are protected against
  formula injection.
- **Audit trail** — sign-ins after failed attempts, approvals, exports and password changes
  are listed under *Settings → Security & activity log*.

## Honest limits

- **Videos are built from your real product photos** (motion, titles, music), not AI-generated
  footage of people or scenes. Lifelike generated footage needs a large AI model that cannot run
  inside a phone or PC app without an outside service. Sharp, well-lit photos give the best result.
- **No voice-over yet**; music is generated on the device.
- **Posting is a tap, not automatic.** Instagram, YouTube and WhatsApp only accept automatic
  posting through their own online services, which would break the "no third party" rule. After
  approval you save the video or use *Share* to hand it straight to those apps.
- **Leads are entered in the app** (by hand, CSV import, or the full-screen capture form for a
  counter or event). A public web form would need an online server.
- **Videos are created while the app is open.** A 20-second full-HD video takes roughly
  30–60 seconds on a typical PC.
- Sound is saved as AAC where the device provides it (Windows, macOS, Android) and as Opus
  otherwise (some Linux systems).

## Development

```bash
npm install
npm run dev          # browser, http://localhost:5173
npm test             # unit tests (encryption, copywriter, leads, autopilot)
npm run test:e2e     # full journey in a real browser incl. video rendering (needs Playwright + ffprobe)
npm run desktop      # run the desktop app
npm run dist:win     # build the Windows installer (on Windows); dist:linux / dist:mac likewise
```

Layout: `src/core` (encryption, storage, copywriter, autopilot, leads), `src/video`
(scene renderer, music synthesiser, MP4 encoder, render queue), `src/ui` (screens),
`electron/` (desktop shell), `.github/workflows/build.yml` (installers).

### Signing the Android app with your own key (recommended)

Without a key the APK is signed with a temporary debug key, and a later build cannot be
installed over an earlier one. To fix that, create a keystore once and add these repository
secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`.

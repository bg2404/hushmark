# Publishing Hushmark on the Chrome Web Store

Everything the submission needs is in this folder. Work through the steps in order; the ones marked **you** need your Google account, a payment or a decision only you can make.

| File | What it is for |
|---|---|
| `../dist/hushmark-<version>.zip` | The package you upload. Build it with `npm run package`. |
| `listing.md` | Text for the **Store listing** tab: name, summary, category, description, image list. |
| `privacy-practices.md` | Answers for the **Privacy practices** tab. |
| `privacy-policy.md`, `privacy-policy.html` | The privacy policy. It must be published at a public address. |
| `assets/` | Store icon, five 1280×800 screenshots, the 440×280 small promo tile. |
| `sample/website-relaunch.md` | The document shown in the screenshots. |

## 1. Developer account (you)

1. Choose the Google account that should own Hushmark long term. Google does not let you change a developer account's email after registering: moving later means a new developer account and a support request to transfer the item. Review results and policy notices go to this account.
2. Turn on **2-Step Verification** for that account. Google requires it before you can publish or update anything.
3. Open the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) and register. You accept the developer agreement and pay a one-time **US$5** registration fee.
4. On the **Account** page, set the **Publisher name** (required; the listing shows it after "Offered by"). Then add and verify a **contact email** with **Add email** (required for a new account). The listing shows it under contact information and the privacy policy tells people to use it, so pick an address you are happy to make public.
5. Declare **trader or non-trader** status. Google asks every developer, because of the EU Digital Services Act. Traders publish a legal name, phone number and address; non-traders do not, and buyers are told that consumer-protection rights for traders do not apply. A free hobby project is usually non-trader, but this is your call.

## 2. Optional: a support page (you)

Hushmark is free, with a support link to https://buymeacoffee.com/furiouslad23. To change it:

1. Put its `https://` address in `extension/src/config.js` as `supportUrl`. Settings then shows a **Buy me a coffee** button pinned to the bottom of the drawer; while it is empty, nothing is shown.
2. Change the address in the listing's FREE section (`listing.md`) to match, or delete that section.

`npm run package` reminds you while the address is empty, and refuses one that is not `https://`.

## 3. The privacy policy's public address

The repository bg2404/hushmark is public, so the policy is published where GitHub renders it:

https://github.com/bg2404/hushmark/blob/main/store/privacy-policy.md

Use that address in the dashboard. It opens without signing in, and it always shows the policy on `main`, so after any change to `privacy-policy.md` run `npm run store:policy` (which rebuilds the HTML copy) and push. Keep the file at that path: moving or renaming it breaks the link the store shows.

GitHub Pages is on for the repository, but it cannot serve the policy: bg2404.github.io redirects to www.bhaskergoel.com, which Vercel serves, and Vercel answers unknown paths with the website's home page. To give the policy a page on that domain instead, add `privacy-policy.html` (self-contained: no scripts, no external resources) to the website's own project.

## 4. Build and check the package

```bash
npm run package
```

This checks the manifest against the store's rules (name up to 75 characters, description up to 132, valid version, every referenced file present, exactly the permissions the privacy answers justify (activeTab, scripting, storage, and file, http and https hosts), a background worker, and the gate scripts it registers) and writes `dist/hushmark-<version>.zip` with `manifest.json` at the root. The build is reproducible: the same sources always give the same SHA-256, which the command prints.

To run the whole test suite against the zip exactly as it will be uploaded:

```bash
V=$(node -p "require('./extension/manifest.json').version") && rm -rf /tmp/hushmark-zip && mkdir /tmp/hushmark-zip && unzip -q "dist/hushmark-$V.zip" -d /tmp/hushmark-zip && HUSHMARK_EXTENSION_DIR=/tmp/hushmark-zip npm test
```

## 5. Create the item

1. In the dashboard choose **Add new item** and upload the zip.
2. **Store listing** tab: copy the fields from `listing.md` and upload the images from `assets/`.
3. **Privacy practices** tab: copy the answers from `privacy-practices.md`, and paste the privacy policy URL from step 3 (https://github.com/bg2404/hushmark/blob/main/store/privacy-policy.md).
4. **Test instructions** tab (optional, but it helps the reviewer, who would otherwise see nothing happen): paste the text below.
5. **Distribution** tab: choose visibility (**Public**, or **Unlisted** to share by link first) and regions (all regions is the default).
6. Click **Submit for review**. The confirmation dialog has a checkbox to publish automatically when the review passes. Leave it checked to go live on approval. Uncheck it for deferred publishing, then publish from the dashboard within 30 days of approval, or the submission reverts to a draft. If you left it checked and change your mind, choose **Defer publish** from the item's menu.

```text
Hushmark formats Markdown files: local files, and raw .md files on websites. No account or credentials are needed. To test it:
1. Websites (no setup): open a raw Markdown file, for example https://raw.githubusercontent.com/github/docs/main/README.md. It is shown formatted, with Read, Edit and Source in the top bar; on a website, Save becomes Download and saves a copy where the site allows downloads (raw.githubusercontent.com blocks them, and the status bar says so; https://gitlab.com/gitlab-org/gitlab/-/raw/master/README.md allows them). Ordinary HTML pages are never changed.
2. Toolbar button: on a plain-text tab whose address does not end in .md, click the Hushmark icon in the toolbar (pin it from the puzzle icon first); the tab is formatted. On a normal web page the icon shows a "!" badge and does nothing.
3. The sliders icon at the top right opens Settings. Turning off "Format Markdown files on websites" stops Hushmark from running on websites (reload the tab to see the plain text again); the toolbar button still works.
4. Local files: open chrome://extensions, click Details under Hushmark and turn on "Allow access to file URLs" (Chrome does not run extensions on local files until this is on). Save some Markdown in a file ending in .md and open it in Chrome with Ctrl+O (Cmd+O on Mac). Ctrl+S saves: the first time, Chrome's file dialog opens; choose the same file, then allow Chrome's prompt to save changes.
5. Other local files (off by default): open Hushmark's settings page (right-click the toolbar icon, then Options; on a website, Settings shows these switches read-only and links there) and turn on "Format Markdown in other local files". Save these four lines as trip.txt and open it:
   # Trip notes
   - [ ] passport and tickets
   - [x] charger for the laptop
   See the [map](https://example.com/map) before leaving.
   (a blank line between the heading, the list and the last line is fine). It is formatted, with a "Show as plain text" button. Short or loosely structured text may stay plain on purpose; the toolbar button formats it on request. A .py, .log or .json file is never formatted.
```

## 6. Review

- Google says most reviews finish within a few days and some take a few weeks. New developers and new items get closer review, so the first submission is likely to be the slowest. Contact developer support if a review passes three weeks.
- Access to all websites (`http://*/*`, `https://*/*`) is one of the broad host permissions Google names as a reason for a longer, more careful review, and the dashboard may show a notice about it. The justification in `privacy-practices.md` explains why it is needed and how narrowly it is used. If a reviewer asks you to narrow it, the fallback is to drop the automatic website script and keep only the toolbar button, which needs `activeTab` instead.
- Promo images are reviewed separately and show "Pending review" for up to about a week; the listing can go live before they appear.
- With **deferred publishing** (step 5.6), an approved item must be published within 30 days or it reverts to draft.
- New publishers can publish up to two items before asking for a higher limit; Hushmark is one.

## 7. After it is live

Before you start, remove any unpacked copy of Hushmark from `chrome://extensions` in that Chrome. An unpacked copy has file access by default, and whichever copy runs first renders the page, so with both installed check 2 could pass even if the store copy does not work.

Install Hushmark from the store in your everyday Chrome. Chrome's install dialog will say it can "Read and change all your data on all websites"; that is the website access the listing explains. Then check the things that cannot be tested before a store install:

1. On `chrome://extensions` → Hushmark → **Details**, the **Allow access to file URLs** toggle is present and **off**. Chromium's source suggests a store install starts with it off, and the listing tells users to turn it on.
2. Turn it on, open any `.md` file, and confirm it renders.
3. Open a raw `.md` file on a website and confirm it renders without any extra step.
4. Pin the toolbar icon and click it on a plain-text tab whose address has no `.md`.

## Updating later

1. Change the code, bump `version` in `extension/manifest.json`.
2. `npm test`, then `npm run package`, then the zip test from step 4.
3. Upload the new zip on the item's **Package** tab and submit. The name and summary come from the manifest, so changing them also needs a new version.
4. If what Hushmark stores or reads changes, update `privacy-policy.md`, `privacy-practices.md` and the Privacy practices tab together. Google removes items whose disclosures contradict their behaviour.

## Regenerating the images

```bash
npm run store:assets
```

The screenshots are of the real extension running in Chromium on `sample/website-relaunch.md`, at exactly 1280×800, with no alpha channel. The script fails if any image has an alpha channel or if any network request happens while rendering.

## Sources

Google's documentation behind these steps, checked October 2026:

- [Register your developer account](https://developer.chrome.com/docs/webstore/register) and [Set up your developer account](https://developer.chrome.com/docs/webstore/set-up-account)
- [Two-step verification requirement](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)
- [Trader verification FAQ](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq)
- [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [Supplying images](https://developer.chrome.com/docs/webstore/images) and [Listing best practices](https://developer.chrome.com/docs/webstore/best-listing)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) and [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Review process](https://developer.chrome.com/docs/webstore/review-process) and [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Branding guidelines](https://developer.chrome.com/docs/webstore/branding)
- [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) (file access needs the user's toggle)

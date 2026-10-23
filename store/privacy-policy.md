# Hushmark privacy policy

*Effective 23 October 2026*

Hushmark is a browser extension that displays Markdown files as formatted documents and lets you edit them: files on your computer, and raw Markdown files on websites. This policy describes everything Hushmark reads, keeps and sends.

The short version: **Hushmark reads the Markdown file you open, inside your browser, only to show and edit it, and keeps your settings in its own storage on this computer. It never sends, sells or shares that text or anything else, and it has no servers.**

## What Hushmark reads

Hushmark reads the text of a Markdown file you open in Chrome, in that browser tab, to show it formatted and to let you edit it. In the Chrome Web Store's terms this is "website content", and it is the only kind of user data Hushmark handles. The text is processed only in your browser. It is never sent anywhere.

It does this on:

- **Files on your computer**: `file://` addresses ending in `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt` or `.mdtext`, once you turn on Chrome's "Allow access to file URLs" setting for Hushmark.
- **Files on websites**: web addresses ending the same way, when the site serves them as plain text (as raw files are). This is on by default and can be turned off with **Format Markdown files on websites** in Hushmark's settings; when it is off, Hushmark's code does not run on websites at all.
- **Other text files on your computer**, only if you turn on **Format Markdown in other local files** in Hushmark's settings (it is off by default). When Chrome shows a local file as plain text and its name is not that of code, configuration, data or a log, Hushmark reads its first 64 KB and its last 200 characters in that tab to check whether it looks like Markdown, and formats it only if it does. The check runs in the tab; nothing is recorded or sent.
- **A tab where you click Hushmark's toolbar button**, if that tab shows plain text.

Hushmark also asks for access to local files (`file:///*`) for the third case; Chrome shows no extra warning for it, and it still requires "Allow access to file URLs". Hushmark needs permission to access all websites for the second case, and Chrome shows that permission when you install. Hushmark does not use it on ordinary web pages. On a page whose address ends in .md but that the site serves as HTML, only a short check runs: it looks at the page type and stops, without changing the page or loading the rest of Hushmark. Hushmark never runs inside frames, and it does not collect or record your browsing history or the addresses of the pages you visit. The only addresses it keeps are of local files, as described below: files you save, if you turn on **Remember saved files**, and files you turn back to plain text, in memory until Chrome closes.

## Images and media from other sites

A Markdown file can embed images, video or audio from a web address. Loading one would tell that server that the file was opened, so **Hushmark does not load them**. It shows a bar saying how many it held back, with a **Load images** button. A file on a website may show images from its own site, which already served the file.

If you click **Load images**, or turn on **Load web images automatically** in Hushmark's settings, Chrome loads them like on any web page, and those servers receive the requests. Links you click open normally.

## What Hushmark stores, on your computer only

- **Your settings**: theme, font, text size, page width, whether the outline, autosave, spell checking, automatic web images, website formatting, formatting of other local files and remembered files are on, and the position of the source/preview divider. They are kept in the extension's own storage (`chrome.storage.local`), which web pages and other local files cannot change; only your own clicks in Settings do. On a website, the switches for privacy, editing and local files are read-only, because the site's own scripts share that page; you change them in Hushmark's settings page (right-click Hushmark's icon, then **Options**), which no website can reach. Chrome deletes it when you uninstall Hushmark. While Hushmark shows a Markdown file from a website, scripts from that site can see the display settings applied to that page, such as the theme. Earlier versions kept settings in the storage of `file://` pages; Hushmark moves them over the first time you open a local file after updating, leaving out the options that lower privacy, and deletes them from there.
- **Permission to save a file on your computer**: the first time you save a file, you pick it in Chrome's file dialog, and Chrome gives Hushmark a handle to that file. Hushmark keeps the handle in memory for that tab only. If you turn on **Remember saved files**, Hushmark also keeps the handle in the IndexedDB storage of `file://` pages, under the file's full address (for example `file:///Users/you/notes/plan.md`), one entry for each file you save, so later visits need only Chrome's permission prompt. This setting is off by default.

- **Files you show as plain text**: when you click **Show as plain text** on a file Hushmark formatted because of its content, Hushmark remembers that file's address in the extension's memory (`chrome.storage.session`), so reloading the tab keeps it plain. It is never written to disk, and Chrome forgets it when it closes.

None of this is synced or sent anywhere. Hushmark never writes anything to a website's own storage.

Chrome gives every `file://` page one shared storage area, so other local HTML files you open in Chrome can read the remembered file addresses. While Chrome's permission to edit a remembered file lasts, such a page could use its handle to write to that file without asking again. That permission lasts until you close every tab showing a local file, or permanently if you chose "Allow on every visit" when Chrome asked. Leave **Remember saved files** off to avoid this.

### Removing what Hushmark stores

- **Settings → Forget saved files**, in a tab showing a file from your computer, removes every remembered file handle and address.
- **Settings → Reset all Hushmark data** removes those and your settings. Used in a tab showing a file from a website, it resets your settings at once and removes remembered files the next time you open a file from your computer.
- Uninstalling Hushmark removes your settings. Remembered file addresses are kept by Chrome with the storage of local files rather than with the extension, so use **Forget saved files** in a tab showing a local file before uninstalling, or delete Chrome's stored site data.

## Saving

For a file on your computer, Hushmark writes only to the file you linked by picking it in Chrome's file dialog. Before writing it checks that the file has the same name as the one you opened and still holds the text this tab opened, and it does not write otherwise, or if the file changed on disk in the meantime. A browser page cannot see which folder a file is in, so an identical copy in another folder would pass this check. A file in an older encoding such as Windows-1252 is saved as UTF-8.

A file on a website cannot be written back, so there **Save** becomes **Download** and saves a copy, unless the site blocks downloads, which Hushmark then tells you. If writing to a local file fails, or your browser cannot write files directly, Hushmark downloads a copy instead. Chrome saves a downloaded copy like any other download, usually in your Downloads folder.

## What Hushmark does not do

- It makes no network requests of its own.
- It has no analytics, telemetry, crash reporting, advertising or tracking.
- It has no accounts and no sign-in.
- It does not record which websites or pages you visit.
- It does not download or run code from anywhere; all of its code ships inside the extension.
- It does not sell, transfer or share the text it reads, or any other data, with anyone.

## Spell checking

Spell checking in the editor is off by default. If you turn it on in Hushmark's settings, Chrome's own spell checker checks the text according to your Chrome settings. With Chrome's "Enhanced spell check" enabled, Chrome sends that text to Google.

## Support link

If the publisher has set up a support page, Hushmark's settings show a **Buy me a coffee** link. It is an ordinary link: it opens that page in a new tab only when you click it, without telling the page which file you were viewing, and Hushmark sends nothing to it. Anything you do on that page is covered by that site's own policy.

## Limited Use

Hushmark's use of the information it handles adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements. The file text is used only to display and edit the file you opened. It is not sold, not transferred, not used for any other purpose, and not used to determine creditworthiness or for lending.

## Children

Hushmark sends no information about anyone, including children, off your device.

## Changes

If what Hushmark reads, stores or sends ever changes, the change will ship in a new version together with an updated policy at this address with a new effective date, updated Chrome Web Store disclosures, and a notice inside Hushmark before the new behaviour starts.

## Contact

Questions about this policy: use the developer contact email shown on Hushmark's Chrome Web Store listing.

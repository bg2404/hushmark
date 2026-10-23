# Chrome Web Store listing: Hushmark

Paste these into the **Store listing** tab of the developer dashboard. The store shows the detailed description as plain text, keeping line breaks, so the block below uses "•" bullets rather than Markdown.

## Name

Hushmark

(Comes from `name` in `extension/manifest.json`.)

## Summary

Private Markdown viewer and editor for files on your computer and on the web. No analytics, no tracking, no accounts.

(Comes from `description` in the manifest: 117 of the 132 characters allowed.)

## Category

Workflow & Planning

(Google's description of this category names document editors. Avoid Privacy & Security: it is meant for VPNs, password managers and similar protection tools.)

## Language

English

## Detailed description

````text
Hushmark shows Markdown files as clean, readable documents and lets you edit them, both files on your computer and raw .md files on websites. It never sends your text anywhere.

Open a .md file in Google Chrome™ (drag it onto a tab, or press Ctrl+O, Cmd+O on Mac), or open a raw .md file on a website, and Hushmark formats it the way GitHub formats a README. Switch to Edit to change it in place, or to Source for the raw text with a live preview.

WHY IT ASKS FOR ACCESS TO WEBSITES
To format Markdown files on any site, Chrome requires access to all websites, and shows "Read and change all your data on all websites" when you install. Hushmark uses that access only on plain-text pages whose address ends in .md or a similar extension, and on a tab where you click its toolbar button. It never changes ordinary web pages, and it never runs inside frames. Turn off "Format Markdown files on websites" in Settings and it stops running on websites altogether, unless you click the button.

WHAT HUSHMARK READS AND KEEPS
• It reads the text of the file you open, only to show and edit it in that tab, and never sends it anywhere.
• It makes no network requests of its own: no analytics, no telemetry, no accounts, no sync.
• Images, video and audio that a file embeds from other sites are not loaded until you click "Load images", so no server learns that you opened the file.
• It keeps your settings in its own storage in this browser. Nothing is written to a website's storage. Remembering saved files between visits is off unless you turn it on.
• All of its code ships inside the extension; nothing is downloaded or run from elsewhere.
• Inline HTML in a file is cleaned before it is shown: scripts, forms and event handlers are removed.
• Spell check is off by default. If you turn it on, the browser's own spell checker checks the text according to your browser settings.
• Optional: format other text files on your computer that contain Markdown, such as notes.txt. It is off by default, it checks only files Chrome shows as plain text, and code, logs and data files are never formatted. Each such file has a "Show as plain text" button.

FILES ON YOUR COMPUTER: ONE STEP AFTER INSTALLING
Extensions cannot read files on your computer until you allow it:
1. Open chrome://extensions
2. Find Hushmark and click Details
3. Turn on "Allow access to file URLs"
Then open a .md file (reload the tab if it was already open). Files on websites need no extra step.

READ
• Tables, task lists, strikethrough, autolinks and fenced code blocks (GitHub Flavored syntax)
• Heading links and an outline sidebar for long documents
• YAML front matter shown as a small table
• Relative links and images next to the file work; links to other .md files open formatted too
• Accents, CJK scripts and emoji display correctly
• The toolbar button formats any plain-text tab, even when its address has no .md

EDIT
• What-you-see-is-what-you-get editing with a formatting toolbar
• Shortcuts as you type: "# " for headings, "- " for lists, "[ ] " for tasks, "```" for code, "> " for quotes
• Tables: add and remove rows and columns, Tab to move between cells
• Keyboard shortcuts for headings, bold, italic, strikethrough, code, links, images, lists, tasks, quotes and code blocks, and full keyboard access to the toolbars
• Source mode with a live preview and a resizable split
• Edits are written back as clean, readable text; a file you only read is never touched

SAVE
• Ctrl+S (Cmd+S on Mac) saves a file on your computer. The first time, pick the file itself in the dialog that opens; before writing, Hushmark checks that it has the same name and still holds the text you opened.
• If the file changed on disk since you opened it, Hushmark does not overwrite it.
• Keeps the file's encoding (UTF-8 or UTF-16), byte-order mark and line endings; a file in an older encoding such as Windows-1252 is saved as UTF-8.
• On a website, Save becomes Download and saves a copy, where the site allows downloads.
• Optional autosave for files on your computer

LOOK
• Nine themes, among them GitHub Light and Dark, Solarized and Nord, or Auto to follow your system's light or dark setting
• Sans-serif, serif or monospace text, adjustable size, full width or a reading column
• Works in narrow windows too

FREE
Hushmark is free, with no paid features. If it is useful to you, you can support it at https://buymeacoffee.com/furiouslad23

Google Chrome is a trademark of Google LLC. Use of this trademark is subject to Google Permissions.
````

The support address matches `supportUrl` in `extension/src/config.js`; change both together.

(Counts, against Google's keyword-spam guidance: "Markdown" appears four times in the description and once in the summary; three brands are named.)

## Images

Upload from `store/assets/`:

| Field | File | Size |
|---|---|---|
| Store icon | `store-icon-128.png` | 128×128, 96×96 artwork with transparent padding |
| Screenshot 1 | `screenshot-1.png` | 1280×800: Read mode with the outline |
| Screenshot 2 | `screenshot-2.png` | 1280×800: Edit mode, formatting bar and table tools |
| Screenshot 3 | `screenshot-3.png` | 1280×800: Source mode with live preview, GitHub Dark |
| Screenshot 4 | `screenshot-4.png` | 1280×800: Settings, previewing the Nord theme from the theme picker |
| Screenshot 5 | `screenshot-5.png` | 1280×800: Sepia theme, serif text, reading column |
| Small promo tile | `promo-small.png` | 440×280 |

Regenerate them any time with `npm run store:assets`.

## Optional fields

- **Homepage URL**: https://github.com/bg2404/hushmark (the repository is public).
- **Support URL**: https://github.com/bg2404/hushmark/issues Google expects meaningful support either way; the contact email on the listing covers it.

# Hushmark

*A private Markdown viewer and editor for Chrome, for files on your computer and on the web. Your text never leaves your browser.*

A Chrome extension that shows Markdown files, from your computer or raw files
on the web, as formatted documents, the way GitHub renders a README, and lets you edit them
in place: a WYSIWYG editor with a formatting bar and Markdown shortcuts, a
side-by-side source editor, and saving straight back to the file. Nine colour
themes plus an automatic light/dark one, three font families, adjustable text size. An app-style layout that
uses the whole window and works down to phone widths.

It exists because most Markdown extensions bundle analytics or pull code
from a server. Hushmark does neither. It asks for website access only to
format raw Markdown files, which you can turn off, and it is built to be
inspected, not trusted on faith.

## Privacy

- **Runs on Markdown files, local and on the web.** On your computer it
  matches `file:///` addresses ending in `.md`, `.markdown`, `.mdown`,
  `.mkd`, `.mkdn`, `.mdwn`, `.mdtxt` or `.mdtext` (Chrome's URL patterns are
  case-sensitive, so `.MD`, `.Md`, `.Markdown` and `.MARKDOWN` are listed
  too). On websites it formats pages whose address ends the same way and
  that the site serves as plain text, such as raw files on GitHub. Turn
  "Format Markdown files on websites" off in Settings and
  Hushmark's code no longer runs on websites at all: the background worker
  unregisters the website script. That script is a short gate
  (`src/web-gate.js`): on a page whose address ends in `.md` but that the
  site serves as HTML, it checks the page type and stops, without changing
  anything or loading the rest of Hushmark. It never runs inside frames.
- **Asks only for what that needs, and says why.**
  - *Access to websites* (`http://*/*`, `https://*/*`) so it can format
    Markdown files on any site. Chrome shows this at install as "Read and
    change all your data on all websites". Hushmark uses it only on
    plain-text pages ending in a Markdown extension, or on a tab where you
    click its toolbar button.
  - `scripting` to register that website script and to run the toolbar
    button; `activeTab` so the button also works on the tab you clicked
    when it is a local text file; `storage` for your settings.
  - Chrome's own "Allow access to file URLs" switch, which Chrome requires
    for any extension that touches local files.
- **Makes no network requests of its own.** There are no update checks, no
  telemetry, no analytics, no accounts. The test suite opens every fixture
  in a real Chromium, edits and saves them through every mode, and fails if
  any page in the whole run sends a request off the computer, apart from the
  stand-in website it serves itself and the images it deliberately asks to
  load in the web-images test.
- **Holds back images from other sites.** If a file embeds images, video or
  audio from the web, Hushmark does not load them, because the request
  would tell that server the file was opened. That includes disguised
  addresses Chrome would still accept, such as `https:host/x.png` or network
  paths. (A file on a website may show images from its own site, which
  already served the file.) A bar says how many were held back and offers
  "Load images"; Settings can make that automatic.
- **Spell checking is off** in the editor unless you turn it on in Settings,
  because Chrome's "enhanced" spell check sends typed text to Google.
- **Stores almost nothing, only on this computer.**
  - Your settings, in the extension's own storage (`chrome.storage.local`):
    changed only by your own clicks in Hushmark's Settings, never by web
    pages or other local files, and removed when you uninstall. While
    Hushmark shows a file from a website, that site's scripts can see the
    display settings applied to the page, such as the theme. (Earlier
    versions kept settings in the `localStorage` of `file://` pages; they
    are moved over the first time you open a local file after updating,
    without the options that lower privacy, and deleted from there.)
  - The link to a file you save is kept in memory for that tab; only if you
    turn on "Remember saved files" is it also kept in the
    `IndexedDB` of `file://` pages, under the file's address. Other local
    HTML files can read that, and uninstalling does not clear it, so it is
    off by default. Settings → "Forget saved files" and "Reset all Hushmark
    data", in a tab showing a local file, remove it.
  - Nothing is ever written to a website's own storage.
- **Ships all of its code.** Four widely used npm packages are vendored
  byte-for-byte from npm, with versions and SHA-256 hashes recorded in
  [extension/vendor/VERSIONS.md](extension/vendor/VERSIONS.md): marked
  (Markdown to HTML), DOMPurify (HTML sanitizer), Turndown and its GFM plugin
  (HTML back to Markdown). Chrome's Manifest V3 forbids remotely hosted code
  anyway; this extension has none.
- **Is small enough to read.** Our own code lives in
  [extension/src](extension/src): twelve commented JavaScript files and three
  stylesheets, no build step, no minification.


## Install

Publishing to the Chrome Web Store is prepared in [`store/`](store/README.md). Until then, load it unpacked:

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the [`extension`](extension) folder of
   this project.
4. On the new card click **Details**, then turn on **Allow access to file
   URLs** (for files on your computer; websites need no extra step).
5. Open a Markdown file: drag it onto a tab, press `Cmd+O`, or run

```bash
open -a "Google Chrome" README.md
```

On a website, open any raw `.md` file. For plain text whose address has no
Markdown extension, click Hushmark's toolbar button (pin it from the puzzle
icon first).

Because it is loaded unpacked, Chrome will not update it behind your back.
Edit the files, then click the reload icon on the extension card to pick up
changes.

## Using it

The bar at the top has three modes.

**Read** is the rendered document: GitHub Flavored Markdown with tables, task
lists, strikethrough, autolinks and fenced code; heading anchors (`#` on
hover, so `notes.md#some-heading` links work, including from other files);
YAML front matter as a small table; relative links and images resolved next
to the file; a link to another `.md` file opens it rendered.

**Edit** turns the rendered document into a WYSIWYG editor.

- The formatting bar covers headings, bold, italic, strikethrough, inline
  code, links, images, bulleted, numbered and task lists, quotes, code
  blocks, tables, rules, undo/redo and clear formatting. Hover a button for
  its shortcut.
- Type Markdown at the start of a line and it converts as you go: `# ` to
  `###### ` for headings, `- ` for a list, `1. ` for a numbered list, `> ` for
  a quote, `[ ] ` inside a list item for a task, ```` ```js ```` + Enter for a
  code block, `---` + Enter for a rule.
- In a task list, Enter starts the next task; Enter on an empty task leaves
  the list. Click a checkbox to tick it.
- `Tab` and `Shift+Tab` nest and un-nest list items, move between table
  cells (Tab in the last cell adds a row), or indent inside a code block.
  A small toolbar above any table adds or removes rows and columns; press
  `Option+T` (`Alt+T` elsewhere) to reach it from the keyboard.
- `Cmd+Enter` steps out of a code block, quote or table into a new paragraph.
- Pasted HTML is sanitized with the same rules as rendering; pasted text is
  inserted as text.
- Front matter is shown read-only above the editor and written back
  unchanged; change it in Source mode.

**Source** shows the raw Markdown in a text editor with a live preview next
to it; drag the divider (or focus it and use the arrow keys) to resize the
panes. Edits here are exact: nothing is reformatted.

**Saving.** `Cmd+S` or the Save button writes the file through Chrome's File
System Access API. Chrome does not let a page write to a file just because
it opened it, so the first save opens Chrome's file dialog: go to the file's
folder (the dialog opens in your last-used one) and pick the file itself,
then allow Chrome's prompt to save changes. Hushmark checks that the picked
file has the same name and still holds the text this tab opened, and saves
nothing otherwise, so a same-named file elsewhere, or a file changed by
another program, is never overwritten. (A browser page cannot see a file's
folder, so an identical copy elsewhere would pass the check.) The file keeps
its encoding (UTF-8 or UTF-16), byte-order mark and line endings; a file in
an older encoding such as Windows-1252 is saved as UTF-8. Saving with no changes writes
nothing. Unsaved changes show as a dot on the Save button and the tab title,
and Chrome warns before closing the tab (sites that sandbox their files,
such as raw.githubusercontent.com, suppress that warning). If writing fails, a copy is
downloaded instead and the status bar says so. "Autosave" in Settings saves
two seconds after each change once the file is linked; if an autosave fails
it stops until the next manual save.

**On websites** a raw `.md` file opens formatted, with the same Read, Edit
and Source modes. Save becomes **Download**: a website's file cannot be
written back, so it saves a copy, unless the site blocks downloads
(raw.githubusercontent.com does), and then the status bar says so. Hushmark's
toolbar button formats any
plain-text tab, for example a raw file whose address has no Markdown
extension.

**Outline** opens a sidebar of headings. The sliders button opens the
settings drawer. Appearance has a theme menu (Auto, then the light themes
GitHub Light, Solarized Light and Sepia, then the dark ones GitHub Dark,
Solarized Dark, Nord, Dracula, Gruvbox Dark and One Dark); resting the
pointer on a theme, or moving to it with the arrow keys, previews it on the
page, and it is kept only if you pick it. Then font (sans-serif, serif,
monospace), text size and line width (full width by default, or a
comfortable or narrow column). Editing has autosave and spell check, Websites
has "Format Markdown files on websites" (on by default), and Privacy has
"Load web images automatically", "Remember saved files", "Forget saved files"
(in a tab showing a local file) and "Reset all Hushmark data", which asks
first. The "Buy me a coffee" link stays pinned to the bottom of the drawer. The status bar shows word and character counts,
reading time and save state. Print styles hide the chrome.

The layout is an app shell rather than a page: the bars stay put and the
document scrolls in its own area. Below about 900 px the outline becomes a
drawer and source and preview stack; below about 640 px the mode and save
buttons collapse to icons and the formatting bar scrolls sideways.

### Keyboard shortcuts (macOS; use Ctrl on other systems)

| Keys | Action |
|---|---|
| `Cmd+S` | Save |
| `Cmd+B`, `Cmd+I`, `Cmd+Shift+X` | Bold, italic, strikethrough |
| `Cmd+E` | Inline code |
| `Cmd+K`, `Cmd+Shift+K` | Link, image |
| `Cmd+Option+1` … `6`, `Cmd+Option+0` | Heading level, paragraph |
| `Cmd+Shift+8`, `Cmd+Shift+7`, `Cmd+Shift+9` | Bulleted, numbered, task list |
| `Cmd+Shift+.` | Quote |
| `Cmd+Option+C` | Code block |
| `Cmd+Enter` | New paragraph after the current block |
| `Tab`, `Shift+Tab` | Nest list item, next/previous table cell |
| `Option+T` (in a table) | Focus the table tools; `←`/`→` choose, `Enter` applies, `Esc` or `Tab` returns to the cell, `Shift+Tab` goes to the formatting bar |
| `Cmd+Z`, `Cmd+Shift+Z` | Undo, redo |
| `Esc` | Close a dialog or the settings panel |

### How edits are written back

Edit mode works on the rendered HTML, so saving converts the document back
to Markdown. Three rules keep that honest:

- A file you only read, or only touch in Source mode, is never reformatted.
  Conversion happens only when something changed in Edit mode and was not
  undone.
- The conversion writes GitHub-style Markdown: `#` headings, `-` bullets,
  `1.` numbering, `**bold**`, `*italic*`, `~~strike~~`, fenced code blocks
  with their language, pipe tables with alignment, `- [x]` tasks, `---`
  rules. The test suite round-trips every fixture through render, convert,
  render and checks that the structure and text are identical.
- Inline HTML that Markdown cannot express (`<kbd>`, `<sup>`, `<p align>`,
  `<img width>`, named anchors, HTML comments) is kept as HTML; the Markdown
  inside a `<details>` block stays Markdown. Literal `<` and `&` in prose are
  escaped so they cannot turn into markup.

## What is sanitized

Inline HTML in a document is allowed but cleaned with DOMPurify, both when
rendering and when pasting: scripts, styles, inline `style` attributes,
forms and other inputs, iframes, objects, SVG, MathML, event handlers and
`javascript:` links are removed. Task-list checkboxes are the only `<input>`
that survives, disabled outside Edit mode. The link and image dialogs reject
anything but http(s), mailto, tel, file and relative URLs.

Chrome shows local text files as windows-1252 by default, which garbles
accents, CJK text and emoji in UTF-8 files without a byte-order mark; the
extension reverses that decoding and re-reads the bytes as UTF-8 when they
are valid UTF-8, so what you see (and save) is the real text.

## What it leaves out, on purpose

- **Syntax highlighting.** A highlighter is 100 KB or more of extra code to
  audit. Code blocks are styled but not coloured.
- **Watching the file for outside changes.** Reload the tab to pick up edits
  made in another program.
- **Footnotes, emoji shortcodes, math, diagrams.** Plain GFM only.

## Layout

```
extension/                what you load into Chrome
  manifest.json           Manifest V3
  src/content.js          detects Chrome's plain-text view, fixes encoding, mounts the app
  src/render.js           Markdown -> sanitized HTML, heading anchors, front matter
  src/markdown-out.js     edited HTML -> Markdown (Turndown rules)
  src/editor.js           WYSIWYG editor: toolbar, shortcuts, lists, tables, dialogs
  src/file-access.js      saving through the File System Access API
  src/prefs.js            theme / font / size / width / autosave preferences
  src/icons.js            inline SVG icons for the toolbar and app chrome
  src/app.js              app shell: modes, outline, status bar, save flow
  src/settings.js         the Settings drawer: theme picker, toggles, data buttons, support link
  src/background.js       service worker: the website gate and the toolbar button
  src/web-gate.js         the only script registered for websites: loads Hushmark into plain-text .md pages only
  src/config.js           publisher settings (the optional support link)
  src/themes.css          colour themes and typography variables
  src/content.css         document styles
  src/editor.css          app shell, toolbar, drawers, dialogs, responsive rules
  vendor/                 marked, DOMPurify, Turndown, Turndown GFM (see VERSIONS.md)
  icons/                  icon.svg and the PNG sizes Chrome wants
scripts/vendor.mjs        copies the libraries from node_modules and records hashes
scripts/package.mjs       builds and checks the Chrome Web Store zip (npm run package)
scripts/store-assets.mjs  renders the store screenshots, promo tile and icon (npm run store:assets)
scripts/privacy-page.mjs  turns store/privacy-policy.md into a standalone page (npm run store:policy)
store/                    everything for the Chrome Web Store submission; start at store/README.md
test/e2e.mjs              Playwright test against the fixtures in test/fixtures
```

## Verifying it yourself

Read the files in `extension/src`. Then confirm the vendored libraries are
the published ones:

```bash
shasum -a 256 extension/vendor/*.js
```

and compare with `extension/vendor/VERSIONS.md`, or let npm download the
packages again and compare byte for byte:

```bash
npm install && npm run vendor:check
```

The tests load the unpacked extension into a throwaway Chromium profile, open
the fixtures from disk (including an XSS fixture of script, handler and URL
payloads), and check rendering, themes, every editing feature including
paste, Markdown round-trip fidelity for every fixture, saving (through a
stand-in for Chrome's open dialog injected into the extension's own script
context, including the permission prompt and a wrong file name), the phone
and tablet layouts, sanitizing, and that no page in the run makes a network
request:

```bash
npm install && npm test
```

The test needs Playwright's Chromium (`npx playwright install chromium` if it
is not already cached). Google Chrome itself cannot be used because stable
builds ignore the `--load-extension` flag since Chrome 137.

## Updating the libraries

The versions are pinned exactly, so `npm update` will not move them. Check
what is newer with `npm outdated`, then:

```bash
npm install marked@latest dompurify@latest turndown@latest turndown-plugin-gfm@latest && npm run vendor && npm test
```

Then review the new hashes in `extension/vendor/VERSIONS.md`.

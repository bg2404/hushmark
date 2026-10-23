# Local Markdown Viewer

A Chrome extension that shows Markdown files from your own computer as
formatted documents, the way GitHub renders a README, and lets you edit them
in place: a WYSIWYG editor with a formatting bar and Markdown shortcuts, a
side-by-side source editor, and saving straight back to the file. Ten colour
themes, three font families, adjustable text size. An app-style layout that
uses the whole window and works down to phone widths.

It exists because most Markdown extensions want access to every website,
bundle analytics, or pull code from a server. This one is built to be
inspected, not trusted on faith.

## Privacy

- **Runs only on local Markdown files.** The content script matches
  `file:///` URLs that end in `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`,
  `.mdwn`, `.mdtxt` or `.mdtext` (Chrome's URL patterns are case-sensitive,
  so `.MD`, `.Md`, `.Markdown` and `.MARKDOWN` are listed too). It never
  runs on a website.
- **Makes no network requests.** Nothing is fetched, there are no update
  checks, no telemetry, no analytics. The test suite opens every fixture in a
  real Chromium, edits and saves one of them through every mode, and fails
  if any page in the whole run issues a single `http(s)` request.
- **Spell checking is off** in the editor unless you turn it on in Settings,
  because Chrome's "enhanced" spell check sends typed text to Google.
- **Asks for no permissions.** `manifest.json` has no `permissions`, no
  `host_permissions`, no background worker, no options page. The only switch
  you flip is Chrome's own "Allow access to file URLs", which Chrome requires
  for any extension that touches local files. Saving uses the browser's
  standard File System Access API, which asks you to confirm the file.
- **Stores only two things, only on this computer.** Your appearance and
  editing settings (in the browser's `localStorage` for `file://` pages) and,
  once you have saved a file, Chrome's handle to that file (in `IndexedDB`,
  keyed by the file's URL) so the next save does not need the file dialog
  again. Neither is synced anywhere; "Forget file access" in Settings drops
  the handle. One thing to know: Chrome gives every `file://` page the same
  storage origin, so any local HTML file you open could read these values
  (the handle is useless without Chrome's permission prompt, and the
  settings are just colours and sizes).
- **Ships all of its code.** Four widely used libraries are vendored
  byte-for-byte from npm, with versions and SHA-256 hashes recorded in
  [extension/vendor/VERSIONS.md](extension/vendor/VERSIONS.md): marked
  (Markdown to HTML), DOMPurify (HTML sanitizer), Turndown and its GFM plugin
  (HTML back to Markdown). Chrome's Manifest V3 forbids remotely hosted code
  anyway; this extension has none.
- **Is small enough to read.** Our own code lives in
  [extension/src](extension/src): eight commented JavaScript files and three
  stylesheets, no build step, no minification.

One honest caveat: if a document *you open* embeds an image, audio or video
from the web (including a video's poster or subtitle track), Chrome fetches
it exactly as it would on any web page, and the live preview in Source mode
re-renders as you type. The extension does not add requests, but it does not
block the document's own either.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the [`extension`](extension) folder of
   this project.
4. On the new card click **Details**, then turn on **Allow access to file
   URLs**.
5. Open a Markdown file: drag it onto a tab, press `Cmd+O`, or run

```bash
open -a "Google Chrome" README.md
```

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
System Access API. The first time, Chrome shows its save dialog, which opens
in your last-used folder rather than next to the file: navigate to the file
you have open and pick it to overwrite it (Chrome does not let a page write
to a file just because it opened it). If you pick a file with a different
name, the text is written there as a copy, the document stays marked
unsaved, and nothing is remembered. After a save in place the handle is
remembered for this file, so later saves only need Chrome's one-click
permission prompt, including after a reload; before a remembered handle is
used again, its file is compared with what the page loaded, and a handle
that points somewhere else is dropped. Line endings (`CRLF`) and a UTF-8
byte-order mark are preserved. Unsaved changes show as a dot on the Save
button and the tab title, and Chrome warns before closing the tab. If direct
saving fails, a copy is downloaded instead and the status bar says so.
"Autosave" in Settings saves two seconds after each change once a first
manual save has granted access; if an autosave fails it stops until the next
manual save.

**Outline** opens a sidebar of headings. The sliders button opens the
settings drawer: theme swatches (Auto, GitHub Light, GitHub Dark, Solarized
Light, Solarized Dark, Sepia, Nord, Dracula, Gruvbox Dark, One Dark), font
(sans-serif, serif, monospace), text size, line width (full width by default,
or a comfortable or narrow column), autosave. The status bar shows word and
character counts, reading time and save state. Print styles hide the chrome.

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
  manifest.json           Manifest V3, no permissions
  src/content.js          detects Chrome's plain-text view, fixes encoding, mounts the app
  src/render.js           Markdown -> sanitized HTML, heading anchors, front matter
  src/markdown-out.js     edited HTML -> Markdown (Turndown rules)
  src/editor.js           WYSIWYG editor: toolbar, shortcuts, lists, tables, dialogs
  src/file-access.js      saving through the File System Access API
  src/prefs.js            theme / font / size / width / autosave preferences
  src/icons.js            inline SVG icons for the toolbar and app chrome
  src/app.js              app shell: modes, outline, status bar, settings, save flow
  src/themes.css          colour themes and typography variables
  src/content.css         document styles
  src/editor.css          app shell, toolbar, drawers, dialogs, responsive rules
  vendor/                 marked, DOMPurify, Turndown, Turndown GFM (see VERSIONS.md)
  icons/                  icon.svg and the PNG sizes Chrome wants
scripts/vendor.mjs        copies the libraries from node_modules and records hashes
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
stand-in for Chrome's save dialog injected into the extension's own script
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

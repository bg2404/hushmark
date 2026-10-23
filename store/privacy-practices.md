# Privacy practices tab: Hushmark

Answers for the **Privacy practices** tab of the Chrome Web Store developer dashboard. Every answer has to match the privacy policy and what the extension actually does; Google removes items whose answers contradict either. These answers were written against the code in `extension/` and against `store/privacy-policy.md`.

## Single purpose description

```text
Hushmark displays Markdown files as formatted documents and lets the user edit them: files the user opens from their own computer (file:// addresses ending in .md, .markdown and similar, and, if the user turns on "Format Markdown in other local files", other local text files whose content looks like Markdown), and plain-text Markdown files on websites (web addresses ending the same way, such as raw files). Local files can be saved back to disk; files on websites can be downloaded as a copy. Everything happens in the browser tab; the extension makes no network requests of its own.
```

## Permission justification

The dashboard lists each permission in the manifest with a field to justify it. Paste these:

**storage**

```text
Keeps the user's display, editing and privacy settings (theme, font, text size, whether to format Markdown files on websites, and so on) in chrome.storage.local, so they apply in every tab and are never written to a website's own storage. Nothing else is stored there, and nothing is synced. When the user clicks "Show as plain text" on a local file the extension formatted because of its content, that file's address is kept in chrome.storage.session (memory only, cleared when the browser closes) so a reload keeps the file plain.
```

**scripting**

```text
Used for three things only: (1) to register the content script that formats Markdown files on websites, and to unregister it when the user turns that option off in Settings, so no code runs on websites while it is off; (2) while the user has "Format Markdown in other local files" turned on (off by default), to register a small gate script for local files, to unregister it when the option is turned off, and to inject the renderer into a local file the gate found looks like Markdown; (3) when the user clicks the toolbar button, to inject the same renderer into that tab if it shows plain text.
```

**activeTab**

```text
Keeps the toolbar button working on the tab the user clicked when the user has restricted Hushmark's site access in Chrome (for example to "On click"). Access is temporary, limited to that tab, and only happens on the user's click.
```

**Host permissions** (`http://*/*`, `https://*/*`, `file:///*`)

```text
Markdown files can be on any website (raw files on GitHub, GitLab, documentation sites, and so on), so the content script that formats them must be able to run on any host. Only a short gate script is registered, and only for addresses ending in a Markdown extension (.md, .markdown and similar). It exits immediately, changing nothing, unless the page is a plain-text document; only then is the rest of the extension loaded into that page, so ordinary HTML pages are never changed. It does not run in frames, and it can be turned off in Settings. The extension reads only the text of that Markdown file, to display and edit it in the tab; it sends nothing anywhere, makes no network requests, and does not read or record which pages the user visits.

file:///* is used only if the user turns on "Format Markdown in other local files" (off by default), for local text files that are not named .md but contain Markdown, such as notes.txt. While that setting is on, a small gate script is registered for local files. It reads the first 64 KB and the last 200 characters of a file Chrome shows as plain text, in the tab, skips code, configuration, data and log files, and only if the text looks like Markdown is the rest of the extension loaded into that page. Chrome also requires the user to turn on "Allow access to file URLs". Nothing is sent anywhere.
```

Local Markdown files are matched by the manifest's own content script (`file:///*.md` and similar endings), which Chrome only runs after the user turns on "Allow access to file URLs". If the dashboard asks about it, use the host-permission text above.

## Remote code

Select **No, I am not using remote code.**

All JavaScript ships in the package. The four libraries (marked, DOMPurify, Turndown and its GFM plugin) are bundled byte for byte from npm, with SHA-256 hashes in `extension/vendor/VERSIONS.md`; marked's build is minified upstream, which Google allows. The `http://` and `https://` strings in the code are regular expressions, URL-scheme checks, XML namespace identifiers, an error message and comments inside those libraries, plus a placeholder in Hushmark's link dialog (`src/editor.js`), the web address patterns and host permissions for Markdown files on websites (`manifest.json`, `src/background.js`), the `https://` checks for the support link (`src/settings.js`, `src/background.js`, `scripts/package.mjs`) and the support page address in `src/config.js`. Nothing is fetched or evaluated at run time.

## Data usage

Google's User Data FAQ says that data handled only on the user's device still has to be disclosed, so the conservative answer is to declare the one thing Hushmark reads.

**What user data do you plan to collect from users now or in the future?**

| Category | Check? | Why |
|---|---|---|
| Personally identifiable information | No | Hushmark asks for and stores no names, emails, addresses or IDs. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | No | No accounts, passwords or tokens. |
| Personal communications | No | |
| Location | No | |
| Web history | No | Hushmark does not read or record which pages the user visits. On websites it runs only on Markdown files and reads only their text. The only addresses it can keep are of local files: files the user saved, only if the user turns on "Remember saved files", to remember save permission; and files the user turned back to plain text with "Show as plain text", kept in chrome.storage.session (memory only, cleared when the browser closes). Both stay on the device and are never transmitted. |
| User activity | No | Key presses are handled only to edit text; nothing is logged or recorded. |
| **Website content** | **Yes** | It reads the text of the Markdown file the user opens, on their computer or on a website, to display and edit it, entirely inside the browser tab. With "Format Markdown in other local files" on, it also reads the start of local plain-text files the user opens, in the tab, to check whether they are Markdown. |

The store listing will then say Hushmark "handles" website content. That is accurate, and the listing description and privacy policy both explain that the text never leaves the computer.

**Certifications** (check all three):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

https://github.com/bg2404/hushmark/blob/main/store/privacy-policy.md

The repository is public, so this opens without signing in. See step 3 of `store/README.md` for keeping it current.

## Where the in-product disclosures are

Google's guidance on prominent disclosure is not consistent about local-only processing, so Hushmark also states it inside the product:

- The Settings drawer has a **Files and websites** section with the switch for formatting Markdown in other local files (off by default) and the switch for formatting Markdown files on websites, each saying what it does.
- A local file formatted because of its content shows a bar: "Hushmark formatted this file because it looks like Markdown.", with a **Show as plain text** button.
- On a website, the switches for privacy, editing and local files are read-only, with a note saying so and an **Open settings page** button. Hushmark's settings page (options.html) is an extension page no website can script, and shows the same settings.
- It also has a **Privacy** section that ends with: "Hushmark reads the file you open only to show and edit it in this tab, and sends nothing anywhere. Images a file embeds from the web load only if you choose. Settings are stored in this browser on this computer."
- When a file embeds web images, a bar above the document says how many were not loaded and offers **Load images**.

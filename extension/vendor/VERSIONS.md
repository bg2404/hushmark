# Vendored libraries

These are byte-for-byte copies of the browser builds shipped in the published
npm packages. The extension loads them from this folder only; nothing is
fetched at runtime.

To verify a file yourself:

```bash
shasum -a 256 extension/vendor/*.js
```

and compare with the table below, or run `npm install && npm run vendor:check`,
which compares each vendored file against the copy npm downloaded and against
the hashes recorded here.

| Package | Version | Source file in package | Vendored as | SHA-256 |
|---|---|---|---|---|
| marked | 18.1.1 | `marked/lib/marked.umd.js` | `extension/vendor/marked.umd.js` | `b82b9334406d8bdd16b6236c08de1cb65b2a859873ca9503d9cc0b292ca3c12a` |
| dompurify | 3.4.17 | `dompurify/dist/purify.js` | `extension/vendor/purify.js` | `a7b6dc750251c79c95592d6abf8908bcecb51319b0b5c4194b82222566ed29b9` |
| turndown | 7.2.4 | `turndown/lib/turndown.browser.umd.js` | `extension/vendor/turndown.browser.umd.js` | `cdf933e0a2085df3c64d6c763331f04345f6c3b25746216e8f1426c9c5253045` |
| turndown-plugin-gfm | 1.0.2 | `turndown-plugin-gfm/dist/turndown-plugin-gfm.js` | `extension/vendor/turndown-plugin-gfm.js` | `cf744cc1b7580f06d64ce236a4ff2630a53d389eccf2133a09d71ca443511912` |

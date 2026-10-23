// Turns store/privacy-policy.md into store/privacy-policy.html: one
// self-contained page with no scripts, fonts or other external resources,
// ready to publish at a public address for the Chrome Web Store listing.
// The page is rendered with the same vendored marked build the extension uses.
//
//   npm run store:policy
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'store', 'privacy-policy.md'), 'utf8');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'extension', 'vendor', 'marked.umd.js'), 'utf8'), sandbox);
const body = new sandbox.marked.Marked({ gfm: true }).parse(source);
const title = (source.match(/^#\s+(.+)$/m) || [, 'Privacy policy'])[1].trim();

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title.replace(/^./, (c) => c.toUpperCase())}</title>
<style>
  :root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --code: #f6f8fa; --link: #0969da; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --fg: #f0f6fc; --muted: #9198a1; --border: #3d444d; --code: #151b23; --link: #4493f8; }
  }
  html { background: var(--bg); color: var(--fg); }
  body {
    max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 4rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 0.25rem; }
  h1 + p { color: var(--muted); margin-top: 0; }
  h2 { font-size: 1.25rem; margin: 2rem 0 0.5rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--border); }
  code { font: 0.875em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); padding: 0.15em 0.35em; border-radius: 4px; }
  a { color: var(--link); }
  li + li { margin-top: 0.35rem; }
</style>
</head>
<body>
${body}</body>
</html>
`;

writeFileSync(join(root, 'store', 'privacy-policy.html'), page);
console.log('store/privacy-policy.html written');

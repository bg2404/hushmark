// Copies the two third-party libraries the extension uses from node_modules
// into extension/vendor/ and records their versions and SHA-256 hashes in
// extension/vendor/VERSIONS.md so anyone can verify the files against npm.
//
// Usage: npm run vendor          copy the files and rewrite VERSIONS.md
//        npm run vendor:check    verify extension/vendor/ matches node_modules/
//                                and the hashes recorded in VERSIONS.md
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'extension', 'vendor');
const versionsFile = join(vendorDir, 'VERSIONS.md');
const files = [
  { pkg: 'marked',              from: 'lib/marked.umd.js',             to: 'marked.umd.js',          license: 'LICENSE' },
  { pkg: 'dompurify',           from: 'dist/purify.js',                to: 'purify.js',              license: 'LICENSE' },
  { pkg: 'turndown',            from: 'lib/turndown.browser.umd.js',   to: 'turndown.browser.umd.js', license: 'LICENSE' },
  { pkg: 'turndown-plugin-gfm', from: 'dist/turndown-plugin-gfm.js',   to: 'turndown-plugin-gfm.js', license: 'LICENSE' },
];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (process.argv.includes('--check')) {
  const recorded = existsSync(versionsFile) ? readFileSync(versionsFile, 'utf8') : '';
  let ok = true;
  for (const f of files) {
    const source = join(root, 'node_modules', f.pkg, f.from);
    const vendored = join(vendorDir, f.to);
    const problems = [];
    if (!existsSync(vendored)) problems.push('missing from extension/vendor');
    if (!existsSync(source)) problems.push('missing from node_modules (run npm install)');
    if (!problems.length) {
      const have = sha256(vendored);
      if (have !== sha256(source)) problems.push('differs from the npm package');
      if (!recorded.includes(have)) problems.push('hash not recorded in VERSIONS.md');
    }
    console.log(`${problems.length ? 'MISMATCH' : 'OK      '} extension/vendor/${f.to}${problems.length ? ': ' + problems.join('; ') : ''}`);
    if (problems.length) ok = false;
  }
  process.exit(ok ? 0 : 1);
}

mkdirSync(vendorDir, { recursive: true });
const rows = [];
for (const f of files) {
  const pkgDir = join(root, 'node_modules', f.pkg);
  const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  copyFileSync(join(pkgDir, f.from), join(vendorDir, f.to));
  copyFileSync(join(pkgDir, f.license), join(vendorDir, `${f.pkg}.LICENSE`));
  rows.push(`| ${f.pkg} | ${version} | \`${f.pkg}/${f.from}\` | \`extension/vendor/${f.to}\` | \`${sha256(join(vendorDir, f.to))}\` |`);
}

writeFileSync(versionsFile, `# Vendored libraries

These are byte-for-byte copies of the browser builds shipped in the published
npm packages. The extension loads them from this folder only; nothing is
fetched at runtime.

To verify a file yourself:

\`\`\`bash
shasum -a 256 extension/vendor/*.js
\`\`\`

and compare with the table below, or run \`npm install && npm run vendor:check\`,
which compares each vendored file against the copy npm downloaded and against
the hashes recorded here.

| Package | Version | Source file in package | Vendored as | SHA-256 |
|---|---|---|---|---|
${rows.join('\n')}
`);
console.log(rows.join('\n'));

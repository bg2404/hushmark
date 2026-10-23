// Builds the Chrome Web Store upload: dist/<name>-<version>.zip with
// manifest.json at the root of the archive.
//
// The archive is reproducible: files are added in sorted order with a fixed
// timestamp, so the same sources always give the same bytes and SHA-256.
// Before writing, the manifest is checked against the store's rules and
// against this project's own promises (exactly the permissions the privacy
// answers justify, a background worker, every referenced file present).
//
//   npm run package
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extension');
const distDir = join(root, 'dist');

const SKIP = [/^\./, /\/\./]; // dotfiles such as .DS_Store
const NAME_MAX = 75;          // Chrome rejects longer manifest names
const DESCRIPTION_MAX = 132;  // the store shows the manifest description as the summary

/* ------------------------------------------------------------- checks */

const problems = [];
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
const exists = (p) => { try { return statSync(join(extDir, p)).isFile(); } catch { return false; } };

if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
if (!manifest.name || manifest.name.length > NAME_MAX) problems.push(`name must be 1-${NAME_MAX} characters`);
if (!manifest.description || manifest.description.length > DESCRIPTION_MAX) {
  problems.push(`description must be 1-${DESCRIPTION_MAX} characters (it is ${(manifest.description || '').length})`);
}
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version || '') || manifest.version.split('.').some((n) => Number(n) > 65535)) {
  problems.push('version must be 1 to 4 dot-separated integers, each 0-65535');
}
// Exactly the permissions the README, listing and privacy answers justify.
const EXPECTED = {
  permissions: ['activeTab', 'scripting', 'storage'],
  host_permissions: ['file:///*', 'http://*/*', 'https://*/*'],
};
for (const [key, expected] of Object.entries(EXPECTED)) {
  const actual = [...(manifest[key] || [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    problems.push(`"${key}" is ${JSON.stringify(actual)}; the documents justify exactly ${JSON.stringify(expected)}`);
  }
}
for (const key of ['optional_permissions', 'optional_host_permissions']) {
  if (manifest[key] && manifest[key].length) problems.push(`"${key}" is not expected`);
}
if (!manifest.background || !manifest.background.service_worker || !exists(manifest.background.service_worker)) {
  problems.push('background.service_worker is missing');
}
// the gates the worker registers (src/background.js, GATES)
for (const file of ['src/web-gate.js', 'src/file-gate.js', 'src/looks-like-markdown.js']) {
  if (!exists(file)) problems.push(`${file} is missing`);
}
// the settings page (options_ui), the only place websites cannot reach
if (!manifest.options_ui || !manifest.options_ui.page || !exists(manifest.options_ui.page)) {
  problems.push('options_ui.page (the settings page) is missing');
} else {
  for (const file of ['src/options.js', 'src/prefs.js', 'src/settings.js']) {
    if (!exists(file)) problems.push(`${file} (used by the settings page) is missing`);
  }
}
for (const [size, file] of Object.entries(manifest.icons || {})) {
  if (!exists(file)) problems.push(`icon ${size} missing: ${file}`);
}
if (!manifest.icons || !manifest.icons['128']) problems.push('a 128x128 icon is required');
for (const cs of manifest.content_scripts || []) {
  for (const file of [...(cs.js || []), ...(cs.css || [])]) {
    if (!exists(file)) problems.push(`content script file missing: ${file}`);
  }
  for (const m of cs.matches || []) {
    if (!/^file:\/\/\//.test(m)) problems.push(`content script matches a non-file URL: ${m}`);
  }
}

if (problems.length) {
  console.error('Not packaged:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// Not an error: the support link is optional.
const config = readFileSync(join(extDir, 'src', 'config.js'), 'utf8');
const supportUrl = (config.match(/supportUrl:\s*'([^']*)'/) || [])[1] || '';
if (!supportUrl) {
  console.warn('note: supportUrl in extension/src/config.js is empty, so Settings shows no support link');
} else if (!/^https:\/\//.test(supportUrl)) {
  console.error('Not packaged:\n  supportUrl in extension/src/config.js must start with https://');
  process.exit(1);
}

/* -------------------------------------------------------------- files */

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}
const files = walk(extDir)
  .map((full) => relative(extDir, full).split(sep).join('/'))
  .filter((rel) => !SKIP.some((re) => re.test(rel)))
  .sort();

/* ----------------------------------------------------------- zip writer */

// 1980-01-01 00:00, the earliest DOS timestamp, for reproducible output.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

const local = [];
const central = [];
let offset = 0;
for (const rel of files) {
  const data = readFileSync(join(extDir, rel));
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const name = Buffer.from(rel, 'utf8');
  const crc = crc32(data);
  const common = Buffer.concat([
    u16(20),                   // version needed to extract
    u16(0x0800),               // flags: UTF-8 file names
    u16(useDeflate ? 8 : 0),   // method
    u16(DOS_TIME), u16(DOS_DATE),
    u32(crc), u32(body.length), u32(data.length),
    u16(name.length), u16(0),  // name length, extra length
  ]);
  const header = Buffer.concat([u32(0x04034b50), common, name]);
  local.push(header, body);
  central.push(Buffer.concat([
    u32(0x02014b50),
    u16(0x0314),               // made by: Unix, spec 2.0
    common,
    u16(0), u16(0), u16(0),    // comment length, disk number, internal attributes
    u32((0o100644 << 16) >>> 0), // external attributes: regular file, rw-r--r--
    u32(offset),
    name,
  ]));
  offset += header.length + body.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0),
  u16(files.length), u16(files.length),
  u32(centralBuf.length), u32(offset),
  u16(0),
]);
const zip = Buffer.concat([...local, centralBuf, end]);

mkdirSync(distDir, { recursive: true });
const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const out = join(distDir, `${slug}-${manifest.version}.zip`);
writeFileSync(out, zip);

const sha = createHash('sha256').update(zip).digest('hex');
console.log(`${relative(root, out)}  ${files.length} files  ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`sha256 ${sha}`);

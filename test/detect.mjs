// Tests for extension/src/looks-like-markdown.js, the content check that
// decides whether a local file not named .md is formatted (only while
// "Format Markdown in other local files" is on).
//
//   node test/detect.mjs
//
// test/fixtures/detect/ holds hand-made files named pos__<name> (Markdown)
// and neg__<name> (not Markdown); <name> is the file name the check sees.
// A few short Markdown files are known to stay below the threshold: they
// stay plain text, and the toolbar button formats them on demand. They are
// listed in KNOWN_MISSES, so that a change in either direction is noticed.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'extension', 'src', 'looks-like-markdown.js'), 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(source, sandbox);
const { looksLikeMarkdown, THRESHOLD, vetoedByName } = sandbox.globalThis.HushmarkDetect;

const KNOWN_MISSES = new Set(['pos__readme-fence', 'pos__table', 'pos__short-list']);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  (${detail})`}`);
}

check('the threshold is the measured "balanced" one', THRESHOLD === 6);

const dir = join(here, 'fixtures', 'detect');
for (const file of readdirSync(dir).sort()) {
  const [label, name] = file.split('__');
  const text = readFileSync(join(dir, file), 'utf8');
  for (const [mode, fileName] of [['content only', ''], ['with its name', name]]) {
    const { score, reasons } = looksLikeMarkdown(text, fileName);
    const formatted = score >= THRESHOLD;
    const expected = label === 'pos' && !KNOWN_MISSES.has(file);
    const what = label === 'neg' ? 'is never formatted' : expected ? 'is formatted' : 'stays plain (known miss)';
    check(`${file} ${what} (${mode})`, formatted === expected, `score ${score}: ${reasons.join(' ')}`);
  }
}

// names that rule a file out before any text is read
for (const name of ['setup.py', 'app.log', 'data.json', 'config.yaml', 'Main.java', 'notes.org', 'table.csv', 'changes.diff']) {
  check(`${name} is ruled out by its name`, vetoedByName(name) && looksLikeMarkdown('# Title\n\n- [ ] a task\n\n[link](https://example.invalid)\n', name).score < 0);
}
for (const name of ['notes.txt', 'README', 'TODO', 'journal']) {
  check(`${name} is not ruled out by its name`, !vetoedByName(name));
}

// content vetoes
const md = '# Notes\n\nSome words in a sentence here.\n\n- [ ] first task item\n- [x] second task item\n\nSee [the docs](https://example.invalid/docs).\n';
check('Markdown notes in a .txt are formatted', looksLikeMarkdown(md, 'notes.txt').score >= THRESHOLD);
check('a shebang rules a file out', looksLikeMarkdown('#!/bin/sh\n' + md, 'run').score < 0);
check('an <?xml prolog rules a file out', looksLikeMarkdown('<?xml version="1.0"?>\n' + md, 'feed').score < 0);
check('JSON rules a file out', looksLikeMarkdown('{"title": "# Notes", "items": ["- [ ] a"]}', 'data').score < 0);
check('Python with "# comment" lines is not formatted', looksLikeMarkdown('# Helper\n# Run once.\nimport os\n\ndef main():\n    print("hi")\n\n# More\nmain()\n', 'snippet.txt').score < THRESHOLD);
check('a heading alone is never enough', looksLikeMarkdown('# Not markdown\n\nThis is a .txt file and must be left alone.\n', 'plain.txt').score < THRESHOLD);

// the sample the store reviewer is told to save (store/README.md, step 5)
const reviewer = '# Trip notes\n- [ ] passport and tickets\n- [x] charger for the laptop\nSee the [map](https://example.com/map) before leaving.\n';
check('the reviewer sample in store/README.md is formatted', looksLikeMarkdown(reviewer, 'trip.txt').score >= THRESHOLD, looksLikeMarkdown(reviewer, 'trip.txt').score);
check('... also with blank lines between its parts', looksLikeMarkdown(reviewer.replace(/\n(?=- \[ \]|See)/g, '\n\n'), 'trip.txt').score >= THRESHOLD);

// what is read: the first 64 KB, and the last 200 characters for the JSON veto
{
  const pad = 'filler text line with several words in it\n'.repeat(3000); // pushes the rest past 64 KB
  const a = looksLikeMarkdown(md + pad + 'middle one\n' + pad + 'The end of the notes.\n', 'n.txt').score;
  const b = looksLikeMarkdown(md + pad + 'middle two, different\n' + pad + 'The end of the notes.\n', 'n.txt').score;
  check('text past the first 64 KB, except the last 200 characters, does not change the score', a === b, `${a} vs ${b}`);
}

// bounded cost: only the first 64 KB are read
const huge = md + 'filler text line with several words in it\n'.repeat(400000);
const t0 = performance.now();
looksLikeMarkdown(huge, 'big.txt');
const ms = performance.now() - t0;
check(`a ${(huge.length / 1024 / 1024).toFixed(0)} MB file is checked quickly (${ms.toFixed(1)} ms)`, ms < 200);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

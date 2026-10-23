/*
 * Hushmark — looks-like-markdown.js
 *
 * looksLikeMarkdown(text, fileName) -> { score, reasons }
 *
 * The content check for local files whose name does not say Markdown (used
 * by file-gate.js, and only while "Format Markdown in other local files" is
 * on). A higher score is more Markdown-like; Hushmark formats a file at
 * THRESHOLD or above.
 *
 * Hard vetoes first: code, config, data and log file names, shebangs, JSON,
 * mail-style header blocks, triple-quoted strings and diffs. A file then
 * needs at least one strong Markdown construct (a closed code fence, a link,
 * a table, a task item, or several headings in prose) to score above 4, and
 * code-like lines, key=value lines, log timestamps and CSV-like columns count
 * against it. Only the first 64 KB (1,500 lines) is scored, plus the last
 * 200 characters for the JSON veto, so the cost is bounded for any file.
 *
 * Measured on about 6,500 files on a Mac, split into a tuning set and a
 * holdout: no false positives at 6 or 10, and the highest-scoring file that
 * was not Markdown scored 4. About 85% of real Markdown files reach 6; the
 * rest stay plain text, and the toolbar button formats them on demand.
 *
 * No dependencies. Runs in the content script's isolated world, and under
 * Node for test/detect.mjs.
 */
(function (global) {
  'use strict';

  const LLM_THRESHOLDS = { conservative: 10, balanced: 6 };
  const LLM_CODE_EXT = /\.(py|pyw|pyi|js|mjs|cjs|jsx|ts|tsx|mts|cts|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|hh|m|mm|cs|rb|php|pl|pm|lua|r|sh|bash|zsh|fish|ps1|bat|cmd|sql|css|scss|less|html?|xml|svg|json|jsonl|ya?ml|toml|ini|cfg|conf|properties|plist|gradle|cmake|mk|proto|tf|csv|tsv|log|diff|patch|rst|adoc|asciidoc|org|textile|pod|tex|ipynb|lock|env)$/i;
  const LLM_DOC_NAME = /^(readme|changelog|changes|history|news|notes|todo|contributing|authors|roadmap|llms(-full)?)(\.txt)?$/i;

  function looksLikeMarkdown(text, fileName) {
    const name = String(fileName || '').split(/[\\/]/).pop();
    const veto = (why) => ({ score: -100, reasons: [why] });
    if (LLM_CODE_EXT.test(name)) return veto('code/data extension');
    if (/^#!/.test(text)) return veto('shebang');
    const t = text.slice(0, 65536), lines = t.split(/\r?\n/, 1500);
    if (/^\s*(\{\s*["{[}]|\[\s*["{[\]\d-])/.test(t) && /[}\]]\s*$/.test(text.slice(-200))) return veto('json');
    // XML in a file whose extension Chrome does not know is typed text/plain
    if (/^\uFEFF?\s*<\?xml[\s?]/.test(t)) return veto('xml');
    const c = { h1: 0, h1sep: 0, h2: 0, setext: 0, fence: 0, link: 0, ref: 0, table: 0, task: 0, bold: 0, code: 0,
      quote: 0, html: 0, prose: 0, iso: 0, cl: 0, kv: 0, log: 0, rst: 0, hashRun: 0, diff: 0, toml: 0, n: 0 };
    let i = 0, fm = false;
    if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0 && end < 60) { i = end + 1; fm = true; } }
    const head = lines.slice(i, i + 4).filter((l) => l.trim());
    if (head.length >= 3 && head.every((l) => /^[A-Z][\w-]*: \S/.test(l))) return veto('mail/METADATA header block');
    let inFence = null, prev = '', prev2 = '', prevHash = false, tabs = 0;
    const commas = new Map();
    for (; i < lines.length; i++) {
      const l = lines[i].length > 400 ? lines[i].slice(0, 400) : lines[i];
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
      if (inFence) { if (f && f[1][0] === inFence[0] && f[1].length >= inFence.length && !l.slice(f[0].length).trim()) { inFence = null; c.fence++; } continue; }
      // Only closed fences count; "~~~~" directly under a text line is an underline, not a fence.
      // a run of more than 10 tildes or backticks is a separator line, not a fence
      if (f && f[1].length <= 10 && !(f[1][0] === '`' && l.slice(f[0].length).includes('`')) && !(f[1][0] === '~' && prev)) { inFence = f[1]; prev = ''; continue; }
      if (!l.trim()) { prev2 = prev; prev = ''; prevHash = false; continue; }
      c.n++;
      const hash = /^\s*#/.test(l);
      if (hash && prevHash) c.hashRun++;
      prevHash = hash;
      if (/^#\s+\S/.test(l)) { c.h1++; if (!(lines[i + 1] || '').trim()) c.h1sep++; }
      else if (/^#{2,6}\s+\S/.test(l)) c.h2++;
      if (/^#{1,6}\s+\S/.test(l) && !prev && !(lines[i + 1] || '').trim()) c.iso++;
      if (/^ {0,3}(={3,}|-{3,})\s*$/.test(l) && prev && !prev2 && !/^\s*([-*+>#|]|\d+[.)])\s/.test(prev) && !/[;{}]\s*$/.test(prev)) c.setext++;
      if (/!?\[[^\]\n]{1,200}\]\((https?:\/\/|mailto:|#|\.{0,2}\/|[\w.-]+\.(md|png|jpe?g|gif|svg)\b)[^)\s]*( "[^"]*")?\)/.test(l)) c.link++;
      if (/^ {0,3}\[[^\]]+\]:\s*(https?:\/\/|\.{0,2}\/|#)\S*/.test(l)) c.ref++;
      if (prev.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l)) c.table++;
      if (/^\s*[-*+] \[[ xX]\]\s/.test(l)) c.task++;
      if (/(^|[\s(])\*\*[^\s*][^*]*?\*\*(?=[\s.,;:!?)]|$)/.test(l)) c.bold++;
      if (/(^|[\s(])`[^`\s][^`]*`(?=[\s.,;:!?)]|$)/.test(l)) c.code++;
      if (/^ {0,3}>\s?[^>\s]/.test(l)) c.quote++;
      if (/<!--|<\/?(details|summary|img|br|kbd|sup|sub|div|p)\b/i.test(l)) c.html++;
      const bare = l.replace(/`[^`]*`/g, 'x');
      if (/^ {0,3}([-*+] |\d{1,3}[.)] |> )?[A-Za-z(*_"'[]/.test(bare) && (bare.match(/ \S/g) || []).length >= 3 && (bare.match(/[{}=;<>$\\|@^~#]/g) || []).length <= 1) c.prose++;
      if (/[;{]\s*$|^\s*[}\])];?\s*$|^\s*(def|class|import|from \S+ import|function|const|let|var|return|public|private|static|package|func|fn|using|namespace|#include|#define|#if|#endif|#pragma|elif|except|end)\b|^\s*(if|for|while|else|try|with)\b.*:\s*$/.test(l)
        || /^((FROM|RUN|COPY|ADD|ENV|ARG|WORKDIR|CMD|ENTRYPOINT|EXPOSE|LABEL|USER|VOLUME|SHELL) |(export|alias|source|echo|cd|set|unset|local|eval|exec|sudo|apt-get|apt|brew|pip|npm|yarn|pnpm|git|curl|wget|mkdir|rm|cp|mv|chmod|make) )/.test(l)) c.cl++;
      if (/^\s*(- )?["']?[\w.\-/]{1,40}["']?\s*(=\s*\S?.{0,80}|:(\s+\S.{0,60})?)\s*$/.test(l) && !/^\s*(https?|mailto):/.test(l)) c.kv++;
      if (/^\s*\[?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}[.,]\d|[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2})|^\s*\[?(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/.test(l)) c.log++;
      if (/^\.\. [\w|-]+(::|:)|^\.\. _|`[^`]+`_\b|^\s*:\w[\w ]*:\s|``\S[^`]*``/.test(l)) c.rst++;
      if (/^(diff --git |@@ -\d+(,\d+)? \+\d|\+\+\+ [ab/]|--- a\/)/.test(l)) c.diff++;
      if (/^\s*[\w.-]+\s*=\s*("""|''')/.test(l)) return veto('triple-quoted assignment');
      if (/^\s*\[\[?[\w.\- "]+\]\]?\s*$/.test(l)) c.toml++;
      if (c.n <= 60) { const k = (l.match(/,/g) || []).length; if (k >= 2) commas.set(k, (commas.get(k) || 0) + 1); if (/\t\S/.test(l.trim())) tabs++; }
      prev2 = prev; prev = l;
    }
    if (c.diff >= 2) return veto('diff');
    const n = Math.max(c.n, 1), proseOk = c.prose / n >= 0.35 && c.hashRun <= 1;
    let pos = (proseOk ? 3 * Math.min(c.h2, 5) + 2 * Math.min(c.h1, 3) : 2 * Math.min(c.h2, 3) + Math.min(c.h1, 2))
      + 2 * Math.min(c.setext, 3) + 3 * Math.min(c.fence, 4) + 2 * Math.min(c.link, 5) + 2 * Math.min(c.ref, 3)
      + 5 * Math.min(c.table, 2) + 3 * Math.min(c.task, 3) + Math.min(c.bold, 4) + 0.5 * Math.min(c.code, 6)
      + Math.min(c.quote, 3) + Math.min(c.html, 2);
    // "#" lines count as headings in prose only with a "##" heading, or when a
    // blank line follows them: three "# comment" lines over commands are not
    // a document
    const strong = c.fence + c.link + c.ref + c.table + c.task + ((proseOk && (c.h2 ? c.h1 + c.h2 : c.h1sep) >= 2) || (c.iso >= 3 && c.hashRun <= 1) ? 1 : 0);
    if (fm && strong) pos += 3;
    if (strong && LLM_DOC_NAME.test(name)) pos += 2;
    let neg = 30 * (c.cl / n) + 1.5 * Math.min(c.hashRun, 10) + 2 * Math.min(c.rst, 10) + 5 * Math.min(c.toml, 3);
    if (c.kv / n > 0.3) neg += 20 * (c.kv / n);
    if (c.log / n > 0.2) neg += 25 * (c.log / n);
    if (Math.max(0, ...commas.values()) >= 0.6 * Math.min(n, 60) || tabs >= 0.6 * Math.min(n, 60)) neg += 10;
    if (!strong) pos = Math.min(pos, 4); // headings, emphasis or underlines alone are never enough
    const reasons = Object.keys(c).filter((k) => c[k] && k !== 'n').map((k) => k + '=' + c[k]);
    return { score: Math.round((pos - neg) * 10) / 10, reasons: reasons.concat('n=' + c.n) };
  }

  var api = {
    looksLikeMarkdown: looksLikeMarkdown,
    THRESHOLD: LLM_THRESHOLDS.balanced,
    // true when the name alone rules a file out, before reading any text
    vetoedByName: function (fileName) {
      return LLM_CODE_EXT.test(String(fileName || '').split(/[\\/]/).pop());
    }
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.HushmarkDetect = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

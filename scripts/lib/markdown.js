'use strict';

const PLACEHOLDER = '_No entries yet._';
const BASE_MARKER = /<!--\s*changelog-base:\s*(\S+)\s*-->/;

/** Normalize a line for dedupe comparison: strip bullet, PR ref, punctuation, case. */
function normalize(text) {
  return String(text)
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Section-matching key. Beyond `normalize`, this folds the "&"/"and" split so a
 * model answering "Configuration and Secrets" targets `## Configuration & Secrets`
 * instead of forking a near-duplicate section.
 */
function sectionKey(title) {
  return normalize(String(title).replace(/&/g, ' and '))
    .split(' ')
    .filter((w) => w && w !== 'and')
    .join(' ');
}

/**
 * Split markdown into { preamble, sections: [{ title, level, lines }] } on `##`/`###`
 * headings. Both levels are addressable: a playbook can nest capabilities under a
 * top-level area (e.g. `### Features by User Role` inside `## User Guide`).
 */
/**
 * Recognise a heading line. Playbooks mix three forms, and all three must be
 * addressable — the PM template puts real sections inside collapsible blocks:
 *   `## Title`  ·  `<h2>Title</h2>`  ·  `<summary><h3>Title</h3></summary>`
 * Bold markers (`## **Title**`) are stripped from the title but kept in the raw line.
 */
function parseHeading(line) {
  const mdMatch = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
  if (mdMatch) return { title: stripInline(mdMatch[2]), level: mdMatch[1].length };

  const htmlMatch = /<h([23])[^>]*>(.*?)<\/h\1>/i.exec(line);
  if (htmlMatch) return { title: stripInline(htmlMatch[2]), level: Number(htmlMatch[1]) };

  return null;
}

function stripInline(text) {
  return String(text).replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').trim();
}

function parseSections(md) {
  const lines = md.split('\n');
  const preamble = [];
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      // Keep the raw line so collapsible <details>/<summary> markup survives a rewrite.
      current = { ...heading, raw: line, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, sections };
}

function renderSections({ preamble, sections }) {
  const out = [...preamble];
  for (const s of sections) {
    out.push(s.raw !== undefined ? s.raw : `${'#'.repeat(s.level || 2)} ${s.title}`);
    out.push(...s.lines);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

function findSection(sections, title) {
  const want = sectionKey(title);
  return sections.find((s) => sectionKey(s.title) === want) || null;
}

const SCAFFOLD_RE = /^\s*<\/?(details|summary)[^>]*>\s*$/i;

/**
 * Line ranges for each section: `start` is the heading line, `end` is exclusive.
 * Used for surgical edits — we splice into the caller's own line array so an
 * existing document keeps its exact spacing, and the diff shows only the new line.
 */
function sectionRanges(lines) {
  const ranges = [];
  lines.forEach((line, i) => {
    const heading = parseHeading(line);
    if (!heading) return;
    if (ranges.length) ranges[ranges.length - 1].end = i;
    ranges.push({ ...heading, raw: line, start: i, end: lines.length });
  });
  return ranges;
}

/**
 * Insert a bullet under `sectionTitle`, creating the section if missing.
 * Rewrites nothing else: the rest of the file is passed through byte for byte.
 * Returns { content, inserted, reason }.
 */
function insertPlaybookEntry(md, sectionTitle, sentence) {
  const bullet = `- ${String(sentence).trim().replace(/^[-*]\s*/, '')}`;
  const lines = md.split('\n');

  if (lines.some((l) => /^\s*[-*]\s+/.test(l) && normalize(l) === normalize(bullet))) {
    return { content: md, inserted: false, reason: 'duplicate' };
  }

  const ranges = sectionRanges(lines);
  const want = sectionKey(sectionTitle);
  const range = ranges.find((r) => sectionKey(r.title) === want);

  if (!range) {
    const tail = lines.length && lines[lines.length - 1].trim() === '' ? '' : '\n';
    return {
      content: `${md}${tail}\n## ${String(sectionTitle).trim()}\n\n${bullet}\n`,
      inserted: true,
      reason: 'new-section',
    };
  }

  const body = lines.slice(range.start + 1, range.end);

  // A placeholder is replaced in place — one line changed, nothing shifted.
  const placeholderAt = body.findIndex((l) => l.trim() === PLACEHOLDER);
  if (placeholderAt !== -1) {
    lines[range.start + 1 + placeholderAt] = bullet;
    return { content: lines.join('\n'), inserted: true, reason: 'appended' };
  }

  let lastBullet = -1;
  for (let i = 0; i < body.length; i++) if (/^\s*[-*]\s+/.test(body[i])) lastBullet = i;

  if (lastBullet >= 0) {
    // Join an existing list — but a bullet can own indented continuation lines
    // (the `- **Label**` + indented paragraph pattern), and splitting a label from
    // its description would corrupt the section. Step past the whole item first.
    let at = lastBullet + 1;
    while (at < body.length && (body[at].trim() === '' || /^\s+\S/.test(body[at]))) at++;
    while (at > lastBullet + 1 && body[at - 1].trim() === '') at--;
    lines.splice(range.start + 1 + at, 0, bullet);
  } else {
    // First entry: sit after the section's prose, before any closing scaffolding. A body
    // can end with its own </details> AND the <details> that opens the next block, so
    // skip every tag line, not just the first.
    let at = body.length;
    while (at > 0 && (body[at - 1].trim() === '' || SCAFFOLD_RE.test(body[at - 1]))) at--;
    lines.splice(range.start + 1 + at, 0, '', bullet);
  }

  return { content: lines.join('\n'), inserted: true, reason: 'appended' };
}

/**
 * Token-overlap similarity. Lexical dedupe only catches near-identical text; the model
 * restates the same fact in new words across months, and the playbook quietly bloats.
 */
function similarity(a, b) {
  const ta = new Set(normalize(a).split(' ').filter((w) => w.length > 3));
  const tb = new Set(normalize(b).split(' ').filter((w) => w.length > 3));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/**
 * Existing entry that says substantially the same thing, or null.
 * Graded on purpose: a restatement of the same fact scores ~0.6, so 0.85+ is treated
 * as a duplicate and skipped, while 0.6-0.85 is surfaced for a human to judge.
 */
function findNearDuplicate(md, sentence, threshold = 0.6) {
  const bullets = md.split('\n').filter((l) => /^\s*[-*]\s+/.test(l));
  let best = null;
  for (const b of bullets) {
    const score = similarity(b, sentence);
    if (score >= threshold && (!best || score > best.score)) best = { line: b.trim(), score };
  }
  return best;
}

/** Sections carrying more than `limit` entries — a signal to compact by hand. */
function crowdedSections(md, limit = 12) {
  return sectionRanges(md.split('\n'))
    .map((r) => ({
      title: r.title,
      count: md.split('\n').slice(r.start + 1, r.end).filter((l) => /^\s*[-*]\s+/.test(l)).length,
    }))
    .filter((s) => s.count > limit);
}

/** Titles of every addressable section, in document order. */
function sectionTitles(md) {
  return parseSections(md).sections.map((s) => s.title);
}

/** True when `title` resolves to an existing section (same fuzzy match as insertion). */
function hasSection(md, title) {
  return findSection(parseSections(md).sections, title) !== null;
}

function getChangelogBase(md) {
  const m = BASE_MARKER.exec(md);
  return m ? m[1] : null;
}

function setChangelogBase(md, sha) {
  if (BASE_MARKER.test(md)) return md.replace(BASE_MARKER, `<!-- changelog-base: ${sha} -->`);
  return md.replace(/^(#\s+Unreleased\s*\n)/m, `$1\n<!-- changelog-base: ${sha} -->\n`);
}

/** Append a one-line entry under `# Unreleased`. Returns { content, inserted, reason }. */
function insertChangelogEntry(md, entry) {
  const bullet = `- ${String(entry).trim().replace(/^[-*]\s*/, '')}`;
  const lines = md.split('\n');

  if (lines.some((l) => /^\s*[-*]\s+/.test(l) && normalize(l) === normalize(bullet))) {
    return { content: md, inserted: false, reason: 'duplicate' };
  }

  const headingIdx = lines.findIndex((l) => /^#\s+Unreleased\s*$/i.test(l));
  if (headingIdx === -1) {
    return { content: `# Unreleased\n\n${bullet}\n\n${md}`, inserted: true, reason: 'no-heading' };
  }

  // Stop at the next `#`/`##` heading so entries stay inside Unreleased.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  }

  const body = lines.slice(headingIdx + 1, end);

  // "Nothing unreleased" is replaced in place; otherwise append to the existing list.
  const emptyAt = body.findIndex((l) => l.trim() === '_Nothing unreleased._');
  if (emptyAt !== -1) {
    lines[headingIdx + 1 + emptyAt] = bullet;
    return { content: lines.join('\n'), inserted: true, reason: 'appended' };
  }

  let lastBullet = -1;
  for (let i = 0; i < body.length; i++) if (/^\s*[-*]\s+/.test(body[i])) lastBullet = i;

  if (lastBullet >= 0) {
    lines.splice(headingIdx + 1 + lastBullet + 1, 0, bullet);
  } else {
    const markerAt = body.findIndex((l) => BASE_MARKER.test(l));
    lines.splice(headingIdx + 1 + (markerAt >= 0 ? markerAt + 1 : 0), 0, '', bullet);
  }

  return { content: lines.join('\n'), inserted: true, reason: 'appended' };
}

/** Entries currently under `# Unreleased`. */
function unreleasedEntries(md) {
  const lines = md.split('\n');
  const headingIdx = lines.findIndex((l) => /^#\s+Unreleased\s*$/i.test(l));
  if (headingIdx === -1) return [];
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(headingIdx + 1, end).filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.trim());
}

function emptyChangelog(md, sha) {
  return setChangelogBase(`# Unreleased\n\n<!-- changelog-base: ${sha} -->\n\n_Nothing unreleased._\n`, sha);
}

module.exports = {
  PLACEHOLDER,
  normalize,
  sectionKey,
  parseSections,
  renderSections,
  sectionTitles,
  hasSection,
  similarity,
  findNearDuplicate,
  crowdedSections,
  insertPlaybookEntry,
  insertChangelogEntry,
  unreleasedEntries,
  getChangelogBase,
  setChangelogBase,
  emptyChangelog,
};

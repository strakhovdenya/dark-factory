'use strict';

const path = require('node:path');
const baseSet = require('../skills/base-set.json');
const { extractAffectsPatterns } = require('../verifier/affects-scope');

// The one "path to skills" table of the factory. The skill gate hook (requiredSkillDetailsFor) and
// Ralph (requiredSkillsFor) both use it; neither keeps a skill list of its own. The table is the base entries
// below plus the project's skillRules; a profile can add entries but cannot remove or weaken
// a base one.
const BASE_SKILLS = Object.freeze([...baseSet.requiredJsSkills]);
const BASE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

const GLOB_CHARS = /[*?[\]{}]/;
// A file name has a stem before its last extension; ".claude" is a hidden directory, not a file.
const HAS_EXTENSION = /[^./]\.[^./]+$/;
const TRAILING_SEPARATOR = /[\\/]\s*$/;
// "*.ts" or "**.test.ts" as the last segment of a glob: every file name ends with this suffix.
const SUFFIX_GLOB = /^\*+((?:\.[^.*?[\]{}/]+)+)$/;

// Project-relative path with "/" separators, no "./", "//" or ".." segments; '' is the project
// root. null for an empty path, an absolute path or a path that leaves the project.
const normalizePath = (value) => {
  const slashed = value.trim().replace(/\\/g, '/');
  if (slashed === '' || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const normalized = path.posix.normalize(slashed);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/\/+$/, '').replace(/^\.$/, '');
};

// A segment-boundary prefix: '' covers the whole project, "pkg/a" covers "pkg/a" and
// "pkg/a/x.ts" but not "pkg/ab/x.ts".
const covers = (prefix, target) =>
  prefix === '' || target === prefix || target.startsWith(`${prefix}/`);

const endsWithExtension = (name, extension) =>
  name.length > extension.length && name.endsWith(extension);

// One mention of a path: a file, or a directory (every file below it, so its extensions are
// not known). `suffix` limits a directory mention taken from a glob to files ending with it;
// `exact` is the path as written, for the exact-file ADR entry.
const fileMention = (normalized) => ({
  kind: 'file',
  path: normalized,
  suffix: null,
  exact: normalized,
});

const dirMention = (normalized, suffix = null, exact = null) => ({
  kind: 'dir',
  path: normalized,
  suffix,
  exact,
});

// A path token of the Affects section. Paths are data: nothing here touches the file system.
const mentionFromToken = (token) => {
  const normalized = normalizePath(token);
  if (normalized === null) return null;

  if (GLOB_CHARS.test(normalized)) {
    const segments = normalized.split('/');
    const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
    const suffix = SUFFIX_GLOB.exec(segments[segments.length - 1]);
    return dirMention(segments.slice(0, firstGlob).join('/'), suffix ? suffix[1] : null);
  }
  if (TRAILING_SEPARATOR.test(token)) return dirMention(normalized);
  if (HAS_EXTENSION.test(normalized)) return fileMention(normalized);
  // A last segment without an extension may be a directory: include it conservatively,
  // but keep the exact name for the ADR file, which can have any name.
  return dirMention(normalized, null, normalized);
};

// An explicit changed path (hooks): a trailing separator names a directory, anything else a file.
const mentionFromExplicitPath = (value) => {
  const normalized = normalizePath(value);
  if (normalized === null) return null;
  return TRAILING_SEPARATOR.test(value) ? dirMention(normalized) : fileMention(normalized);
};

const extensionsOverlap = (suffix, extension) =>
  extension.endsWith(suffix) || suffix.endsWith(extension);

const matchesEntry = (mention, entry) => {
  if (mention.kind === 'file') {
    if (!covers(entry.path, mention.path)) return false;
    const name = mention.path.slice(mention.path.lastIndexOf('/') + 1);
    return entry.extensions.some((extension) => endsWithExtension(name, extension));
  }
  // A directory and an entry path overlap when one covers the other.
  if (!covers(entry.path, mention.path) && !covers(mention.path, entry.path)) return false;
  if (mention.suffix === null) return true;
  return entry.extensions.some((extension) => extensionsOverlap(mention.suffix, extension));
};

/**
 * @typedef {{ path?: string, extensions?: readonly string[], file?: string, label?: string, skills: readonly string[] }} Entry
 * A path entry (path + extensions) or an exact-file entry (file); only profile entries carry a label.
 */

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** @returns {Entry[]} */
const baseEntries = (profile) => {
  /** @type {Entry[]} */
  const entries = [{ path: '', extensions: BASE_EXTENSIONS, skills: BASE_SKILLS }];
  const adr = profile.docs?.adr;
  if (adr === undefined) return entries;
  if (typeof adr !== 'string') {
    throw new TypeError('skill rules: profile.docs.adr must be a string');
  }
  // docs.adr names one file: a trailing separator (a directory) adds no rule
  const adrPath = TRAILING_SEPARATOR.test(adr) ? null : normalizePath(adr);
  if (adrPath) entries.push({ file: adrPath, skills: ['adr'] });
  return entries;
};

/** @returns {Entry[]} */
const profileEntries = (profile) => {
  const rules = profile.skillRules ?? [];
  if (!Array.isArray(rules)) {
    throw new TypeError('skill rules: profile.skillRules must be an array');
  }
  return rules.map((rule, index) => {
    const entryPath = typeof rule?.path === 'string' ? normalizePath(rule.path) : null;
    const isValid =
      entryPath !== null && isStringArray(rule.extensions) && isStringArray(rule.skills);
    // fail closed: an entry that cannot be applied must not silently drop its skills
    if (!isValid) throw new TypeError(`skill rules: invalid profile.skillRules[${index}]`);
    const label = typeof rule.label === 'string' && rule.label !== '' ? rule.label : undefined;
    return { path: entryPath, extensions: rule.extensions, label, skills: rule.skills };
  });
};

/**
 * Skills that must be loaded before the described files are edited, with the labels of the
 * profile entries that matched (for the hook message).
 * A string is an issue body: only the paths of its Affects section count. An array is a list of
 * explicit paths. Both forms use the same table: the base entries (JS/TS files require the base
 * metaskills; the profile's `docs.adr` file requires `adr`), then the profile's `skillRules`.
 * A directory mention includes its possible extensions conservatively; a file is filtered by
 * the entry's extensions, compound ones (".test.ts") as file name suffixes. Result: unique
 * skill names, base entries first; unique labels of the matched profile entries in profile order.
 * @param {object} profile a loaded, valid profile
 * @param {string|string[]} textOrPaths
 * @returns {{ skills: string[], labels: string[] }}
 */
const requiredSkillDetailsFor = (profile, textOrPaths) => {
  if (profile === null || typeof profile !== 'object') {
    throw new TypeError('skill rules: profile must be a loaded profile object');
  }
  let mentions;
  if (typeof textOrPaths === 'string') {
    mentions = extractAffectsPatterns(textOrPaths).map(mentionFromToken);
  } else if (Array.isArray(textOrPaths) && textOrPaths.every((v) => typeof v === 'string')) {
    mentions = textOrPaths.map(mentionFromExplicitPath);
  } else {
    throw new TypeError('skill rules: expected an issue body (string) or an array of path strings');
  }
  const found = mentions.filter((mention) => mention !== null);

  const skills = new Set();
  const labels = new Set();
  for (const entry of [...baseEntries(profile), ...profileEntries(profile)]) {
    const isHit = found.some((mention) =>
      entry.file === undefined ? matchesEntry(mention, entry) : mention.exact === entry.file,
    );
    if (!isHit) continue;
    for (const skill of entry.skills) skills.add(skill);
    if (entry.label !== undefined) labels.add(entry.label);
  }
  return { skills: [...skills], labels: [...labels] };
};

/**
 * Skills that must be loaded before the described files are edited: the `skills` of
 * requiredSkillDetailsFor (same table, same order).
 * @param {object} profile a loaded, valid profile
 * @param {string|string[]} textOrPaths
 * @returns {string[]}
 */
const requiredSkillsFor = (profile, textOrPaths) => requiredSkillDetailsFor(profile, textOrPaths).skills;

module.exports = { BASE_SKILLS, BASE_EXTENSIONS, requiredSkillsFor, requiredSkillDetailsFor };

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The core contract ships with the package; a project adds to it only through
// its overlay, read from the default branch like the other trusted configs.
const CORE_CONTRACT = path.join(__dirname, 'issue-contract.json');
const DEFAULT_OVERLAY = path.join('.github', 'verifier', 'issue-contract.overlay.json');

const OVERLAY_FIELDS = new Set(['sections', 'forbiddenPhrases']);
const REMOVAL_FIELDS = new Map([
  ['removeSections', 'section'],
  ['removeForbiddenPhrases', 'forbidden phrase'],
]);
const SECTION_FIELDS = new Set(['title', 'alternativeNames', 'required', 'idPrefix']);
const ID_PREFIX = /^[A-Z]+$/;

class OverlayError extends Error {}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

const namesOf = (section) => [section.title, ...(section.alternativeNames ?? [])];

const loadCore = () => JSON.parse(fs.readFileSync(CORE_CONTRACT, 'utf8'));

// A missing file is an empty overlay (nothing to add); an unreadable or
// malformed one is an error, never silently ignored.
const loadOverlay = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new OverlayError(`cannot read ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OverlayError(`${file} is not valid JSON: ${error.message}`);
  }
};

const rejectRemovals = (overlay) => {
  for (const [field, what] of REMOVAL_FIELDS) {
    if (!(field in overlay)) continue;
    const names = Array.isArray(overlay[field]) ? overlay[field].join(', ') : String(overlay[field]);
    throw new OverlayError(`cannot remove base ${what}: ${names}`);
  }
  for (const field of Object.keys(overlay)) {
    if (!OVERLAY_FIELDS.has(field)) throw new OverlayError(`unknown field: ${field}`);
  }
};

const checkAddedSection = (section, taken, prefixes) => {
  if (!isObject(section) || !isNonEmptyString(section.title)) {
    throw new OverlayError('a section needs a non-empty title');
  }
  const { title } = section;
  for (const field of Object.keys(section)) {
    if (!SECTION_FIELDS.has(field)) {
      throw new OverlayError(`section ${title}: unknown field: ${field}`);
    }
  }
  if (typeof section.required !== 'boolean') {
    throw new OverlayError(`section ${title}: required must be true or false`);
  }
  const prefix = section.idPrefix ?? null;
  if (prefix !== null && !(typeof prefix === 'string' && ID_PREFIX.test(prefix))) {
    throw new OverlayError(`section ${title}: idPrefix must be null or upper-case letters`);
  }
  const alternatives = section.alternativeNames ?? [];
  if (!Array.isArray(alternatives) || !alternatives.every(isNonEmptyString)) {
    throw new OverlayError(`section ${title}: alternativeNames must be non-empty strings`);
  }
  for (const name of [title, ...alternatives]) {
    if (taken.has(name)) {
      throw new OverlayError(
        `section ${name} already exists; an overlay cannot redeclare, weaken or rename a section`,
      );
    }
    taken.add(name);
  }
  if (prefix !== null) {
    if (prefixes.has(prefix)) {
      throw new OverlayError(`section ${title}: idPrefix ${prefix} is already used`);
    }
    prefixes.add(prefix);
  }
  return { title, alternativeNames: alternatives, required: section.required, idPrefix: prefix };
};

// Core + overlay. The overlay only adds: sections and forbidden phrases. Anything
// that would remove or weaken the core is rejected with an OverlayError.
const mergeOverlay = (core, overlay) => {
  if (overlay === null || overlay === undefined) return core;
  if (!isObject(overlay)) throw new OverlayError('overlay must be a JSON object');
  rejectRemovals(overlay);

  const added = overlay.sections ?? [];
  const phrases = overlay.forbiddenPhrases ?? [];
  if (!Array.isArray(added)) throw new OverlayError('sections must be an array');
  if (!Array.isArray(phrases) || !phrases.every(isNonEmptyString)) {
    throw new OverlayError('forbiddenPhrases must be an array of non-empty strings');
  }

  const taken = new Set(core.sections.flatMap(namesOf));
  const prefixes = new Set(core.sections.map((section) => section.idPrefix).filter(Boolean));
  const sections = [...core.sections, ...added.map((section) => checkAddedSection(section, taken, prefixes))];

  const known = new Set(core.forbiddenPhrases.map((phrase) => phrase.toLocaleLowerCase()));
  const extra = phrases.filter((phrase) => !known.has(phrase.toLocaleLowerCase()));
  return { ...core, sections, forbiddenPhrases: [...core.forbiddenPhrases, ...extra] };
};

const buildContract = (overlayFile = DEFAULT_OVERLAY) =>
  mergeOverlay(loadCore(), loadOverlay(overlayFile));

// Heading text -> the section's main title, for every name the contract knows.
const canonicalNames = (contract) =>
  new Map(contract.sections.flatMap((section) => namesOf(section).map((name) => [name, section.title])));

module.exports = {
  CORE_CONTRACT,
  DEFAULT_OVERLAY,
  OverlayError,
  namesOf,
  loadCore,
  loadOverlay,
  mergeOverlay,
  buildContract,
  canonicalNames,
};

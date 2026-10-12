'use strict';

const { STATUS_PASS, STATUS_FAIL } = require('./common');
const { readReferencedFile } = require('./refs');
const { parseCiData } = require('./ci');

const CI_VERIFY_PATTERN = /^ci "([^"]+)"$/;
const ABSENCE_VERIFY_PATTERN = /^absent "([^"]+)" in (\S+)$/;

const computedEntry = (id, status, summary) => ({
  id,
  text: '',
  status,
  summary,
  refs: [],
  computed: true,
});

// A literal is matched as a plain substring, never as a pattern: a
// regex-like literal (e.g. "a.b*") only matches itself.
const computeAbsenceItems = (specItems, root) => {
  if (!Array.isArray(specItems)) return [];
  const items = [];
  for (const item of specItems) {
    if (item.type !== 'absence') continue;
    const match = ABSENCE_VERIFY_PATTERN.exec(item.verify ?? '');
    if (!match) {
      const summary = 'malformed absence Verify grammar';
      items.push(computedEntry(item.id, STATUS_FAIL, summary));
      continue;
    }
    const [, literal, filePath] = match;
    const { content, problem } = readReferencedFile(root, filePath);
    if (problem !== null) {
      const summary = `${filePath}: ${problem}`;
      items.push(computedEntry(item.id, STATUS_FAIL, summary));
      continue;
    }
    const found = content.includes(literal);
    const quoted = JSON.stringify(literal);
    const summary = found
      ? `${item.id}: literal ${quoted} found in ${filePath}`
      : `${item.id}: literal ${quoted} not found in ${filePath}`;
    const status = found ? STATUS_FAIL : STATUS_PASS;
    items.push(computedEntry(item.id, status, summary));
  }
  return items;
};

const isCheckRunMatch = (checks, name) => {
  const matches = checks.filter((check) => check.name === name);
  return (
    matches.length === 1 &&
    matches[0].status === 'completed' &&
    matches[0].conclusion === 'success'
  );
};

// ciRaw is the raw ci.json text, read once by the CLI and reused here.
const computeCiItems = (specItems, ciRaw) => {
  if (!Array.isArray(specItems)) return [];
  const ciData = ciRaw === null ? null : parseCiData(ciRaw);
  const items = [];
  for (const item of specItems) {
    if (item.type !== 'ci') continue;
    const match = CI_VERIFY_PATTERN.exec(item.verify ?? '');
    if (!match) {
      items.push(
        computedEntry(item.id, STATUS_FAIL, 'malformed ci Verify grammar'),
      );
      continue;
    }
    const [, checkName] = match;
    if (ciData === null) {
      items.push(
        computedEntry(item.id, STATUS_FAIL, 'CI results were not checked'),
      );
      continue;
    }
    const ok = isCheckRunMatch(ciData.checks, checkName);
    const summary = ok
      ? `CI check "${checkName}" succeeded`
      : `CI check "${checkName}" is missing, in progress, or not successful`;
    items.push(computedEntry(item.id, ok ? STATUS_PASS : STATUS_FAIL, summary));
  }
  return items;
};

module.exports = {
  computeAbsenceItems,
  computeCiItems,
};

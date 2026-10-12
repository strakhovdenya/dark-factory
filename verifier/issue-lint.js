'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONTRACT = path.resolve(
  __dirname,
  '..',
  '.github',
  'verifier',
  'issue-contract.json',
);

const usage = () =>
  'usage: node scripts/issue-lint.js <issue.md> [--contract <path>] [--require-v2] [--out <file.json>]';

const parseArgs = (argv) => {
  let file = null;
  let contract = DEFAULT_CONTRACT;
  let requireV2 = false;
  let out = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--contract' || arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return null;
      if (arg === '--contract') contract = value;
      else out = value;
      index += 1;
    } else if (arg === '--require-v2') {
      requireV2 = true;
    } else if (!arg.startsWith('--') && file === null) {
      file = arg;
    } else {
      return null;
    }
  }

  return file ? { file, contract, requireV2, out } : null;
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const compileContract = (contract) => {
  const invariantSections = new Set(contract.itemSyntax.invariantSections);
  const itemSections = contract.sections.filter((section) => section.idPrefix);
  const checkSections = itemSections.filter(
    (section) => !invariantSections.has(section.title),
  );
  return {
    contract,
    invariantSections,
    itemSections,
    checkSections,
    checkItem: new RegExp(contract.itemSyntax.checkItem),
    invariantItem: new RegExp(contract.itemSyntax.invariantItem),
    fence: new RegExp(contract.parsing.fence),
    topLevelItem: new RegExp(contract.parsing.topLevelItem),
    verifyPatterns: new Map(
      Object.entries(contract.itemTypes).map(([type, definition]) => [
        type,
        new RegExp(definition.verifyPattern),
      ]),
    ),
  };
};

const scan = (markdown, compiled) => {
  const heading = new RegExp(`^#{${compiled.contract.headingLevel}} (.+?)\\s*$`);
  const sectionLines = new Map();
  let currentSection = null;
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (compiled.fence.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = line.match(heading);
    if (headingMatch) {
      currentSection = headingMatch[1];
      if (!sectionLines.has(currentSection)) sectionLines.set(currentSection, []);
      continue;
    }

    if (currentSection && compiled.topLevelItem.test(line)) {
      sectionLines.get(currentSection).push(line);
    }
  }

  return sectionLines;
};

const isV2 = (sectionLines, compiled) => {
  const prefixes = compiled.checkSections.map((section) => section.idPrefix);
  const idPattern = new RegExp(`\\b(?:${prefixes.join('|')})-[1-9][0-9]*\\b`);
  return compiled.checkSections.some((section) =>
    (sectionLines.get(section.title) || []).some((line) => idPattern.test(line)),
  );
};

const wordingProblems = (text, id, contract) => {
  const problems = [];
  const normalize = contract.forbiddenPhrasesIgnoreCase
    ? (value) => value.toLocaleLowerCase()
    : (value) => value;
  const normalized = normalize(text);

  for (const phrase of contract.forbiddenPhrases) {
    if (normalized.includes(normalize(phrase))) {
      problems.push(`${id}: forbidden phrase: ${phrase}`);
    }
  }
  for (const prefix of contract.conditionalItem.startsWith) {
    if (normalized.startsWith(normalize(prefix))) {
      problems.push(`${id}: conditional item is not allowed`);
      break;
    }
  }
  if (
    contract.conditionalItem.contains.some((phrase) =>
      normalized.includes(normalize(phrase)),
    )
  ) {
    problems.push(`${id}: conditional item is not allowed`);
  }
  return problems;
};

const lintV2 = (sectionLines, compiled) => {
  const problems = [];
  const items = [];
  const seenIds = new Set();

  for (const section of compiled.contract.sections) {
    if (section.required && !sectionLines.has(section.title)) {
      problems.push(`missing required section: ${section.title}`);
    }
  }

  for (const section of compiled.itemSections) {
    const lines = sectionLines.get(section.title) || [];
    const invariant = compiled.invariantSections.has(section.title);
    const syntax = invariant ? compiled.invariantItem : compiled.checkItem;

    for (const line of lines) {
      const match = line.match(syntax);
      if (!match || !match.groups) {
        problems.push(`${section.title}: invalid item syntax: ${line}`);
        continue;
      }

      const { id, prefix, type, text, verify } = match.groups;
      if (prefix !== section.idPrefix) {
        problems.push(
          `${id}: prefix ${prefix} does not match section ${section.title}`,
        );
      }
      if (seenIds.has(id)) problems.push(`${id}: duplicate ID`);
      seenIds.add(id);

      if (invariant) {
        problems.push(...wordingProblems(text, id, compiled.contract));
        items.push({ id, section: section.title, type: null, text, verify: null });
        continue;
      }

      const verifyPattern = compiled.verifyPatterns.get(type);
      if (!verifyPattern) {
        problems.push(`${id}: unknown item type: ${type}`);
      } else if (!verifyPattern.test(verify)) {
        problems.push(`${id}: Verify does not match grammar for type ${type}`);
      }
      problems.push(...wordingProblems(text, id, compiled.contract));
      items.push({ id, section: section.title, type, text, verify });
    }
  }

  return { problems, items };
};

const lint = (markdown, contract, { requireV2 = false } = {}) => {
  const compiled = compileContract(contract);
  const sectionLines = scan(markdown, compiled);
  if (!isV2(sectionLines, compiled)) {
    return {
      format: 'legacy',
      problems: requireV2 ? ['legacy format is not allowed'] : [],
      items: [],
    };
  }
  const result = lintV2(sectionLines, compiled);
  return { format: 'v2', ...result };
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  let result;
  try {
    const markdown = fs.readFileSync(args.file, 'utf8');
    const contract = readJson(args.contract);
    result = lint(markdown, contract, { requireV2: args.requireV2 });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, json);
  else process.stdout.write(json);
  return result.problems.length === 0 ? 0 : 1;
};

if (require.main === module) process.exitCode = main();

module.exports = { DEFAULT_CONTRACT, parseArgs, lint, main };

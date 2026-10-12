'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Risk zones the model may name in risk_zones: the core's base list plus the
// zones of the project from its trusted config (.github/verifier/risk-zones.json
// on the default branch). A project adds zones; it never removes or redefines
// a base zone.

const RISK_NONE = 'none';
const NONE_DESCRIPTION = 'none of the above; use it alone, never together with other values';

const BASE_RISK_ZONES = Object.freeze([
  { name: 'auth', description: 'authentication, API keys, authorization, CORS' },
  { name: 'secrets', description: 'secrets, tokens, .env handling' },
  {
    name: 'ci',
    description: '.github/, workflows, CODEOWNERS, verifier files, hooks, build/CI scripts',
  },
  {
    name: 'fs_shell_sinks',
    description: 'filesystem paths, child_process, headless browsers, fetch/URL sinks',
  },
  { name: 'dependencies', description: 'package.json / lockfile / Docker base image changes' },
].map((zone) => Object.freeze(zone)));

const BASE_NAMES = new Set([...BASE_RISK_ZONES.map(({ name }) => name), RISK_NONE]);

const ZONE_NAME = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER = '{{RISK_ZONES}}';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const fail = (message) => {
  throw new Error(`risk zone config: ${message}`);
};

const mentionedBaseZones = (value) =>
  JSON.stringify(value ?? null).match(/[a-z][a-z0-9_]*/g)?.filter((word) => BASE_NAMES.has(word)) ?? [];

const validateZone = (zone, index, seen) => {
  const where = `zones[${index}]`;
  if (!isObject(zone)) fail(`${where} must be an object`);
  for (const key of Object.keys(zone)) {
    if (key !== 'name' && key !== 'description') fail(`${where}.${key}: unknown field`);
  }
  const { name, description } = zone;
  if (typeof name !== 'string' || !ZONE_NAME.test(name)) {
    fail(`${where}.name must match ${ZONE_NAME}`);
  }
  if (BASE_NAMES.has(name)) {
    fail(`${where}.name: base zone "${name}" cannot be redefined; a project can only add zones`);
  }
  if (seen.has(name)) fail(`${where}.name: duplicate zone "${name}"`);
  if (typeof description !== 'string' || description.trim() === '') {
    fail(`${where}.description must be a non-empty string`);
  }
  seen.add(name);
};

// config is the parsed trusted file: { "zones": [{ "name", "description" }] }.
// Returns base zones, then project zones, then "none". Throws on any problem,
// naming the zone or field.
const mergeRiskZones = (config) => {
  if (!isObject(config)) fail('must be a JSON object with a "zones" list');
  for (const [key, value] of Object.entries(config)) {
    if (key === 'zones') continue;
    const [base] = mentionedBaseZones(value);
    if (base !== undefined) {
      fail(`field "${key}" cannot remove base zone "${base}"; a project can only add zones`);
    }
    fail(`unknown field "${key}"`);
  }
  if (!Array.isArray(config.zones)) fail('"zones" must be a list');
  const seen = new Set();
  config.zones.forEach((zone, index) => validateZone(zone, index, seen));
  return [
    ...BASE_RISK_ZONES,
    ...config.zones.map(({ name, description }) => ({ name, description })),
    { name: RISK_NONE, description: NONE_DESCRIPTION },
  ];
};

// The base zones alone: what the model may name when no project zones apply.
const baseRiskZones = () => mergeRiskZones({ zones: [] });

// Fail closed: a missing, unreadable or invalid trusted config throws; the
// caller turns that into a FAIL, never into the base list.
const loadRiskZones = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`risk zone config ${file} not readable: ${error.code ?? error.message}`, {
      cause: error,
    });
  }
  let config;
  try {
    config = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`risk zone config ${file} is not valid JSON: ${error.message}`, { cause: error });
  }
  return mergeRiskZones(config);
};

const zoneNames = (zones) => zones.map(({ name }) => name);

const renderZoneList = (zones) =>
  zones.map(({ name, description }) => `   - ${name}: ${description}`).join('\n');

// Puts the zone list into the prompt in place of the {{RISK_ZONES}} line.
const renderPrompt = (template, zones) => {
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`prompt has no ${PLACEHOLDER} placeholder`);
  }
  // A function replacer: $ in a description is copied, never a pattern.
  return template.replace(PLACEHOLDER, () => renderZoneList(zones));
};

// Returns a copy of the model output schema whose risk_zones enum is the list.
const renderSchema = (schema, zones) => {
  const copy = structuredClone(schema);
  const items = copy?.properties?.risk_zones?.items;
  if (!isObject(items)) throw new Error('schema has no properties.risk_zones.items');
  items.enum = zoneNames(zones);
  return copy;
};

const PROMPT_FILE = path.join(__dirname, 'prompt.md');
const SCHEMA_FILE = path.join(__dirname, 'schema.json');

const USAGE =
  'usage: node verifier/risk-zones.js --config <risk-zones.json> ' +
  '--prompt-out <prompt.md> --schema-out <schema.json>';

const parseArgs = (argv) => {
  const options = { config: null, promptOut: null, schemaOut: null };
  const keys = { '--config': 'config', '--prompt-out': 'promptOut', '--schema-out': 'schemaOut' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith('--')) return null;
    options[key] = value;
    index += 1;
  }
  return Object.values(options).every((value) => value !== null) ? options : null;
};

const main = (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const zones = loadRiskZones(options.config);
    const prompt = renderPrompt(fs.readFileSync(PROMPT_FILE, 'utf8'), zones);
    const schema = renderSchema(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')), zones);
    fs.writeFileSync(options.promptOut, prompt);
    fs.writeFileSync(options.schemaOut, `${JSON.stringify(schema, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  return 0;
};

if (require.main === module) process.exitCode = main();

module.exports = {
  RISK_NONE,
  BASE_RISK_ZONES,
  PLACEHOLDER,
  mergeRiskZones,
  baseRiskZones,
  loadRiskZones,
  zoneNames,
  renderPrompt,
  renderSchema,
  parseArgs,
  main,
};

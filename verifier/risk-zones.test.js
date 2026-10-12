'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BASE_RISK_ZONES,
  PLACEHOLDER,
  mergeRiskZones,
  baseRiskZones,
  loadRiskZones,
  zoneNames,
  renderPrompt,
  renderSchema,
} = require('./risk-zones');

const SCRIPT = path.join(__dirname, 'risk-zones.js');
const BASE = ['auth', 'secrets', 'ci', 'fs_shell_sinks', 'dependencies'];

const PROJECT_ZONES = {
  zones: [
    { name: 'migrations', description: 'database schema or migrations' },
    { name: 'state_machine', description: 'status transitions of core entities' },
  ],
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'risk-zones-'));

const writeJson = (dir, name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};

test('merges base and project risk zones', () => {
  const zones = mergeRiskZones(PROJECT_ZONES);
  assert.deepStrictEqual(zoneNames(zones), [
    ...BASE,
    'migrations',
    'state_machine',
    'none',
  ]);
  assert.strictEqual(
    zones.find(({ name }) => name === 'migrations').description,
    'database schema or migrations',
  );
  assert.deepStrictEqual(zoneNames(BASE_RISK_ZONES), BASE);
  assert.deepStrictEqual(zoneNames(baseRiskZones()), [...BASE, 'none']);
  // Prompt and schema get the same merged list.
  const prompt = renderPrompt(`7. risk_zones:\n${PLACEHOLDER}\n   List`, zones);
  for (const { name, description } of zones) {
    assert.ok(prompt.includes(`   - ${name}: ${description}`), name);
  }
  assert.ok(!prompt.includes(PLACEHOLDER));
  const schema = renderSchema(
    { properties: { risk_zones: { type: 'array', items: { type: 'string' } } } },
    zones,
  );
  assert.deepStrictEqual(schema.properties.risk_zones.items.enum, zoneNames(zones));
});

test('rejects project config removing a base zone', () => {
  assert.throws(
    () => mergeRiskZones({ zones: [], remove: ['secrets'] }),
    /cannot remove base zone "secrets"/,
  );
  assert.throws(
    () => mergeRiskZones({ zones: [], exclude: { zone: 'secrets' } }),
    /cannot remove base zone "secrets"/,
  );
  assert.throws(
    () =>
      mergeRiskZones({
        zones: [{ name: 'secrets', description: 'only vault tokens' }],
      }),
    /base zone "secrets" cannot be redefined/,
  );
  assert.throws(
    () => mergeRiskZones({ zones: [{ name: 'none', description: 'x' }] }),
    /base zone "none" cannot be redefined/,
  );
});

test('rejects malformed project zone configs', () => {
  const cases = [
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
    [{}, /"zones" must be a list/],
    [{ zones: [], extra: 1 }, /unknown field "extra"/],
    [{ zones: ['migrations'] }, /zones\[0\] must be an object/],
    [{ zones: [{ name: 'Bad Name', description: 'x' }] }, /zones\[0\]\.name/],
    [{ zones: [{ name: 'a', description: ' ' }] }, /zones\[0\]\.description/],
    [{ zones: [{ name: 'a', description: 'x', id: 1 }] }, /zones\[0\]\.id: unknown field/],
    [
      { zones: [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }] },
      /duplicate zone "a"/,
    ],
  ];
  for (const [config, message] of cases) {
    assert.throws(() => mergeRiskZones(config), message, JSON.stringify(config));
  }
});

test('loading a missing or invalid trusted config fails instead of using the base list', () => {
  const dir = tempDir();
  assert.throws(() => loadRiskZones(path.join(dir, 'absent.json')), /not readable/);
  assert.throws(() => loadRiskZones(writeJson(dir, 'bad.json', '{oops')), /not valid JSON/);
  const ok = writeJson(dir, 'ok.json', `\uFEFF${JSON.stringify(PROJECT_ZONES)}`);
  assert.ok(zoneNames(loadRiskZones(ok)).includes('state_machine'));
  fs.rmSync(dir, { recursive: true });
});

test('renderPrompt copies $ patterns in descriptions literally', () => {
  const zones = mergeRiskZones({
    zones: [{ name: 'billing', description: "price in $' and $& refunds" }],
  });
  const prompt = renderPrompt(`head\n${PLACEHOLDER}\ntail`, zones);
  assert.ok(prompt.includes("   - billing: price in $' and $& refunds\n"));
  assert.strictEqual(prompt.split('tail').length, 2);
});

test('renderPrompt requires the placeholder', () => {
  assert.throws(() => renderPrompt('no list here', baseRiskZones()), /placeholder/);
  assert.throws(() => renderSchema({ properties: {} }, baseRiskZones()), /risk_zones/);
});

test('core prompt and schema carry only base zones until rendered', () => {
  const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  assert.strictEqual(prompt.split(PLACEHOLDER).length, 2, 'one placeholder');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
  assert.deepStrictEqual(schema.properties.risk_zones.items.enum, [...BASE, 'none']);
});

test('CLI renders the prompt and schema with project zones', () => {
  const dir = tempDir();
  const config = writeJson(dir, 'risk-zones.json', PROJECT_ZONES);
  const promptOut = path.join(dir, 'prompt.md');
  const schemaOut = path.join(dir, 'schema.json');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--config', config, '--prompt-out', promptOut, '--schema-out', schemaOut],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 0, run.stderr);
  const prompt = fs.readFileSync(promptOut, 'utf8');
  assert.ok(prompt.includes('   - secrets: secrets, tokens, .env handling'));
  assert.ok(prompt.includes('   - migrations: database schema or migrations'));
  assert.ok(!prompt.includes(PLACEHOLDER));
  const schema = JSON.parse(fs.readFileSync(schemaOut, 'utf8'));
  assert.deepStrictEqual(schema.properties.risk_zones.items.enum, [
    ...BASE,
    'migrations',
    'state_machine',
    'none',
  ]);
  fs.rmSync(dir, { recursive: true });
});

test('CLI fails on a config removing a base zone and on usage errors', () => {
  const dir = tempDir();
  const config = writeJson(dir, 'risk-zones.json', { zones: [], remove: ['secrets'] });
  const promptOut = path.join(dir, 'prompt.md');
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--config', config, '--prompt-out', promptOut, '--schema-out', path.join(dir, 's.json')],
    { encoding: 'utf8' },
  );
  assert.strictEqual(run.status, 1);
  assert.ok(run.stderr.includes('secrets'), run.stderr);
  assert.strictEqual(fs.existsSync(promptOut), false);
  const usage = spawnSync(process.execPath, [SCRIPT, '--config'], { encoding: 'utf8' });
  assert.strictEqual(usage.status, 2);
  assert.ok(usage.stderr.includes('usage:'));
  fs.rmSync(dir, { recursive: true });
});

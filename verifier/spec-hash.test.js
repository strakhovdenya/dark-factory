'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  APPROVAL_AUTHOR,
  marker,
  normalize,
  hash,
  findApproval,
  approvalComment,
} = require('./spec-hash');

const SCRIPT = path.join(__dirname, 'spec-hash.js');
const OWNERS = ['owner-login'];
const BODY = '## Acceptance Criteria\n- [ ] AC-1 [doc] Text. Verify: a.md\n';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const comment = (body, login = APPROVAL_AUTHOR) => ({ user: { login }, body });

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spec-hash-'));

const runCli = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('hash is sha256 hex of the normalized body', () => {
  const expected = crypto
    .createHash('sha256')
    .update(normalize(BODY), 'utf8')
    .digest('hex');
  assert.strictEqual(hash(BODY), expected);
  assert.match(hash(BODY), /^[0-9a-f]{64}$/);
});

test('checked and unchecked checkboxes give the same hash', () => {
  const lower = BODY.replace('- [ ]', '- [x]');
  const upper = BODY.replace('- [ ]', '- [X]');
  assert.notStrictEqual(lower, BODY);
  assert.strictEqual(hash(lower), hash(BODY));
  assert.strictEqual(hash(upper), hash(BODY));
});

test('line endings and trailing whitespace do not change the hash', () => {
  const crlf = BODY.replace(/\n/g, '\r\n');
  const spaces = BODY.replace(/\n/g, '  \t\n');
  const trailing = `${BODY}\n\n  \n`;
  assert.strictEqual(hash(crlf), hash(BODY));
  assert.strictEqual(hash(spaces), hash(BODY));
  assert.strictEqual(hash(trailing), hash(BODY));
});

test('changing one word changes the hash', () => {
  assert.notStrictEqual(hash(BODY.replace('Text', 'Other')), hash(BODY));
});

test('picks the later of two bot approval comments', () => {
  const comments = [
    comment(`${marker(SHA_A)}\nfirst`),
    comment(`${marker(SHA_B)}\nsecond`),
  ];
  assert.strictEqual(findApproval(comments), SHA_B);
});

test('ignores approval marker from another author', () => {
  const comments = [
    comment(`${marker(SHA_A)}\nbot`),
    comment(`${marker(SHA_B)}\nforged`, 'someone-else'),
  ];
  assert.strictEqual(findApproval(comments), SHA_A);
  assert.strictEqual(findApproval([comments[1]]), null);
});

test('ignores bot comment with marker not at the start', () => {
  assert.strictEqual(findApproval([comment(`note\n${marker(SHA_A)}`)]), null);
});

test('ignores bot comment with malformed hash', () => {
  const short = '<!-- spec-approved sha256=abc -->';
  const nonHex = `<!-- spec-approved sha256=${'z'.repeat(64)} -->`;
  const long = `<!-- spec-approved sha256=${'a'.repeat(65)} -->`;
  const comments = [short, nonHex, long].map((body) => comment(body));
  assert.strictEqual(findApproval(comments), null);
});

test('no comments means no approval', () => {
  assert.strictEqual(findApproval([]), null);
});

test('owner sender gets an approval comment', () => {
  const text = approvalComment(BODY, 'owner-login', OWNERS);
  assert.ok(text.startsWith(marker(hash(BODY))));
  assert.strictEqual(findApproval([comment(text)]), hash(BODY));
});

test('non-owner sender gets no approval comment', () => {
  assert.strictEqual(approvalComment(BODY, 'stranger', OWNERS), null);
});

test('bot sender gets no approval comment even if listed', () => {
  const owners = [...OWNERS, 'helper[bot]'];
  assert.strictEqual(approvalComment(BODY, 'helper[bot]', owners), null);
});

test('cli prints the same hash as hash()', () => {
  const dir = tempDir();
  const file = path.join(dir, 'body.md');
  fs.writeFileSync(file, BODY);
  const run = runCli(['hash', file]);
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), hash(BODY));
  fs.rmSync(dir, { recursive: true });
});

test('cli fails on missing body file', () => {
  const dir = tempDir();
  const run = runCli(['hash', path.join(dir, 'missing.md')]);
  assert.notStrictEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /[0-9a-f]{64}/);
  fs.rmSync(dir, { recursive: true });
});

test('cli approve writes the comment only for an owner', () => {
  const dir = tempDir();
  const body = path.join(dir, 'body.md');
  const owners = path.join(dir, 'owners.json');
  const out = path.join(dir, 'comment.md');
  fs.writeFileSync(body, BODY);
  fs.writeFileSync(owners, JSON.stringify(OWNERS));
  const base = ['approve', '--body', body, '--owners', owners, '--out', out];

  const stranger = runCli([...base, '--sender', 'stranger']);
  assert.strictEqual(stranger.status, 0);
  assert.strictEqual(fs.existsSync(out), false);

  const owner = runCli([...base, '--sender', 'owner-login']);
  assert.strictEqual(owner.status, 0);
  assert.ok(fs.readFileSync(out, 'utf8').startsWith(marker(hash(BODY))));
  fs.rmSync(dir, { recursive: true });
});

test('cli check writes approved and current hashes', () => {
  const dir = tempDir();
  const body = path.join(dir, 'body.md');
  const comments = path.join(dir, 'comments.json');
  const out = path.join(dir, 'spec-approval.json');
  fs.writeFileSync(body, BODY);
  fs.writeFileSync(comments, JSON.stringify([comment(marker(SHA_A))]));
  const args = ['check', '--body', body, '--comments', comments, '--out', out];
  const run = runCli(args);
  assert.strictEqual(run.status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {
    approved_hash: SHA_A,
    current_hash: hash(BODY),
  });
  fs.rmSync(dir, { recursive: true });
});

test('cli check fails and writes nothing on malformed comments', () => {
  const dir = tempDir();
  const body = path.join(dir, 'body.md');
  const comments = path.join(dir, 'comments.json');
  const out = path.join(dir, 'spec-approval.json');
  fs.writeFileSync(body, BODY);
  fs.writeFileSync(comments, '{not json');
  const args = ['check', '--body', body, '--comments', comments, '--out', out];
  assert.strictEqual(runCli(args).status, 1);
  assert.strictEqual(fs.existsSync(out), false);
  fs.rmSync(dir, { recursive: true });
});

test('cli exits 2 on an unknown command or bad options', () => {
  assert.strictEqual(runCli([]).status, 2);
  assert.strictEqual(runCli(['__proto__']).status, 2);
  assert.strictEqual(runCli(['check', '--body']).status, 2);
});

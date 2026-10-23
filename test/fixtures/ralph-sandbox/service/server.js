'use strict';

// Controlled HTTPS service of the Ralph Docker integration: a minimal npm registry with one test
// package in two versions, a 404 for every other package, and a probe path that returns a fixed
// body. Runs in its own container on a test network only, with the fixture's test certificate.
// Every request is logged (method and path), so the test can see what reached it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = 443;
const PROBE_PATH = '/ralph-fixture-probe';
const PROBE_BODY = 'ralph-fixture-service-ok';
const READY_LINE = 'ralph-fixture-service listening';
const PACKAGE = process.env.RALPH_FIXTURE_PACKAGE || 'ralph-fixture-pkg';
const VERSIONS = (process.env.RALPH_FIXTURE_VERSIONS || '1.0.0,2.0.0').split(',');
const HOST = process.env.RALPH_FIXTURE_HOST || 'registry.ralph-fixture.test';
const CERTS = path.join(__dirname, 'certs');

const BLOCK_BYTES = 512;

// One ustar header + content blocks of a regular file.
function tarEntry(name, content) {
  const header = Buffer.alloc(BLOCK_BYTES);
  const put = (text, offset, length) => header.write(text, offset, length, 'utf8');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(content.length, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put(' '.repeat(8), 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padding = Buffer.alloc((BLOCK_BYTES - (content.length % BLOCK_BYTES)) % BLOCK_BYTES);
  return Buffer.concat([header, content, padding]);
}

function tarball(version) {
  const manifest = JSON.stringify({ name: PACKAGE, version, main: 'index.js', license: 'MIT' }, null, 2);
  const entries = [
    tarEntry('package/package.json', Buffer.from(manifest)),
    tarEntry('package/index.js', Buffer.from(`module.exports = ${JSON.stringify(version)};\n`)),
  ];
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(BLOCK_BYTES * 2)]));
}

const tarballs = new Map(VERSIONS.map((version) => [version, tarball(version)]));

const tarballName = (version) => `${PACKAGE}-${version}.tgz`;

function packument() {
  const versions = {};
  for (const [version, data] of tarballs) {
    versions[version] = {
      name: PACKAGE,
      version,
      main: 'index.js',
      dist: {
        tarball: `https://${HOST}/${PACKAGE}/-/${tarballName(version)}`,
        shasum: crypto.createHash('sha1').update(data).digest('hex'),
        integrity: `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`,
      },
    };
  }
  const latest = VERSIONS[VERSIONS.length - 1];
  return { name: PACKAGE, 'dist-tags': { latest }, versions };
}

function handle(req, res) {
  process.stdout.write(`request ${req.method} ${req.url}\n`);
  const url = decodeURIComponent(String(req.url).split('?')[0]);
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };
  if (url === PROBE_PATH) return send(200, 'text/plain', PROBE_BODY);
  if (url === `/${PACKAGE}`) return send(200, 'application/json', JSON.stringify(packument()));
  for (const [version, data] of tarballs) {
    if (url === `/${PACKAGE}/-/${tarballName(version)}`) return send(200, 'application/octet-stream', data);
  }
  return send(404, 'application/json', JSON.stringify({ error: 'Not found' }));
}

function main() {
  const options = {
    key: fs.readFileSync(path.join(CERTS, 'server-key.pem')),
    cert: fs.readFileSync(path.join(CERTS, 'server.pem')),
  };
  https.createServer(options, handle).listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`${READY_LINE} :${PORT}\n`);
  });
}

if (require.main === module) main();

module.exports = { PROBE_PATH, PROBE_BODY, READY_LINE, tarball };

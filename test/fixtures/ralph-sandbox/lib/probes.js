'use strict';

// Probes that run inside the test containers: where a step runs (container, interfaces, user,
// proxy, install env marker) and what it can reach (through the run's proxy or directly). Results
// are plain values; a probe never throws for a refused or failed connection.

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const EVIDENCE_PREFIX = 'RALPH-EVIDENCE ';
const INSTALL_ENV_MARKER = 'RALPH_FIXTURE_INSTALL_ENV';
const CA_FILE = path.join(__dirname, '..', 'service', 'certs', 'ca.pem');
const PROBE_PATH = '/ralph-fixture-probe';
const CONNECT_TIMEOUT_MS = 8000;

const interfaces = () => (fs.existsSync('/sys/class/net') ? fs.readdirSync('/sys/class/net').sort() : []);

const whereAmI = (step) => ({
  step,
  cwd: process.cwd(),
  container: fs.existsSync('/.dockerenv'),
  interfaces: interfaces(),
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  gid: typeof process.getgid === 'function' ? process.getgid() : null,
  proxy: process.env.HTTPS_PROXY || null,
  installEnv: process.env[INSTALL_ENV_MARKER] ?? null,
});

const printEvidence = (value) => process.stdout.write(`${EVIDENCE_PREFIX}${JSON.stringify(value)}\n`);

const proxyAddress = () => {
  const url = new URL(process.env.HTTPS_PROXY);
  return { host: url.hostname, port: Number(url.port) };
};

// HTTPS GET (HTTP/1.0, so the body is not chunked) of the probe path over an open socket;
// resolves the body or an error code.
const fetchOverTls = (socket, servername) =>
  new Promise((resolve) => {
    const secure = tls.connect({ socket, servername, ca: fs.readFileSync(CA_FILE) }, () => {
      secure.write(`GET ${PROBE_PATH} HTTP/1.0\r\nHost: ${servername}\r\n\r\n`);
    });
    let data = '';
    secure.setEncoding('utf8');
    secure.on('data', (chunk) => (data += chunk));
    secure.on('end', () => resolve(data.split('\r\n\r\n').slice(1).join('\r\n\r\n')));
    secure.on('error', (/** @type {NodeJS.ErrnoException} */ error) => resolve(`ERROR:${error.code || error.message}`));
    secure.setTimeout(CONNECT_TIMEOUT_MS, () => {
      secure.destroy();
      resolve('TIMEOUT');
    });
  });

// CONNECT through the run's proxy: { status, body } where body is the probe answer when the tunnel opened.
const viaProxy = (host, servername = host) =>
  new Promise((resolve) => {
    const proxy = proxyAddress();
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${host}:443`, timeout: CONNECT_TIMEOUT_MS });
    req.on('connect', async (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode, body: null });
        return;
      }
      const body = await fetchOverTls(socket, servername);
      socket.destroy();
      resolve({ status: 200, body });
    });
    req.on('error', (/** @type {NodeJS.ErrnoException} */ error) => resolve({ status: error.code || 'ERROR', body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'TIMEOUT', body: null });
    });
    req.end();
  });

// A direct TCP connection to port 443, then the probe over TLS when it connected.
const direct = (host, servername) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port: 443, timeout: CONNECT_TIMEOUT_MS }, async () => {
      const body = await fetchOverTls(socket, servername);
      socket.destroy();
      resolve({ connected: true, body });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ connected: false, error: 'TIMEOUT' });
    });
    socket.on('error', (/** @type {NodeJS.ErrnoException} */ error) => resolve({ connected: false, error: error.code || error.message }));
  });

/**
 * plan: { viaProxy?: [{ host, servername? }], direct?: [{ host, servername }] }. Each entry's result
 * is keyed by its host.
 */
async function probeNetwork(plan) {
  const result = { interfaces: interfaces(), viaProxy: {}, direct: {} };
  for (const entry of plan.viaProxy || []) result.viaProxy[entry.host] = await viaProxy(entry.host, entry.servername);
  for (const entry of plan.direct || []) result.direct[entry.host] = await direct(entry.host, entry.servername);
  return result;
}

const parseEvidence = (text) =>
  String(text)
    .split(/\r?\n/)
    .filter((line) => line.startsWith(EVIDENCE_PREFIX))
    .map((line) => JSON.parse(line.slice(EVIDENCE_PREFIX.length)));

module.exports = { EVIDENCE_PREFIX, INSTALL_ENV_MARKER, CA_FILE, PROBE_PATH, interfaces, whereAmI, printEvidence, viaProxy, direct, probeNetwork, parseEvidence };

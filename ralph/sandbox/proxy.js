'use strict';

// Egress proxy of the Ralph sandbox. Runs in its own container from the sandbox image, on the
// internal network of the agent/install containers and on the default bridge. Only HTTPS CONNECT
// to an allowlisted host on port 443 is tunnelled; the decision is sandbox.js decideProxyRequest(),
// covered by ralph/sandbox.test.js without sockets. Traffic content is never logged.
//
// Requiring this file listens on nothing: the server is created by createProxyServer() and
// started only when the file is run as the entrypoint.

const http = require('node:http');
const net = require('node:net');
const { PROXY_PORT, PROXY_ALLOWED_HOSTS_ENV, PROXY_READY_LINE, parseAuthority, decideProxyRequest, parseAllowedHostsEnv } = require('../sandbox');

const IDLE_TIMEOUT_MS = 120000;
const CONNECT_TIMEOUT_MS = 15000;

const writeLog = (verdict, target) => process.stdout.write(`${verdict} ${String(target).slice(0, 300)}\n`);

function createProxyServer(allowedHosts, log = writeLog) {
  const server = http.createServer((req, res) => {
    log('deny', `${req.method} ${req.url}`);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('ralph sandbox proxy: only CONNECT to allowlisted hosts on 443\n');
  });

  server.on('connect', (req, connection, head) => {
    const clientSocket = /** @type {net.Socket} */ (connection);
    const target = parseAuthority(req.url);
    const decision = decideProxyRequest({ method: req.method, host: target && target.host, port: target && target.port }, allowedHosts);
    if (!decision.allow) {
      log('deny', req.url);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    log('allow', req.url);
    const upstream = net.connect({ host: target.host, port: target.port, timeout: CONNECT_TIMEOUT_MS });
    let isTunnelOpen = false;
    const closeBoth = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.once('connect', () => {
      isTunnelOpen = true;
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('timeout', closeBoth);
    // Once the tunnel is open the client speaks TLS on this socket: a reset just closes it.
    upstream.on('error', () => {
      if (!isTunnelOpen && clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      closeBoth();
    });
    clientSocket.setTimeout(IDLE_TIMEOUT_MS, closeBoth);
    clientSocket.on('error', closeBoth);
  });

  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  server.headersTimeout = CONNECT_TIMEOUT_MS;
  server.requestTimeout = CONNECT_TIMEOUT_MS;
  return server;
}

function main() {
  const allowedHosts = parseAllowedHostsEnv(process.env[PROXY_ALLOWED_HOSTS_ENV]);
  createProxyServer(allowedHosts).listen(PROXY_PORT, '0.0.0.0', () => {
    writeLog(PROXY_READY_LINE, `:${PROXY_PORT} hosts=${allowedHosts.length}`);
  });
}

if (require.main === module) main();

module.exports = { createProxyServer };

'use strict';

// Preload (`node --require`) of a process started from the installed package: on exit it appends
// every file the process loaded to the event log, so the test can tell where the controller and
// the clone's setup came from. It changes nothing in the process.

const fs = require('node:fs');

process.on('exit', () => {
  const log = process.env.INSTALLED_RALPH_LOG;
  if (!log) return;
  const event = { event: 'modules', role: process.env.INSTALLED_RALPH_ROLE || 'controller', files: Object.keys(require.cache) };
  fs.appendFileSync(log, `${JSON.stringify(event)}\n`);
});

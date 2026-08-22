#!/usr/bin/env node
// Hands every invocation straight to the native binary install.js parked beside this file.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const binary = path.join(
  __dirname,
  process.platform === 'win32' ? 'monosplice-native.exe' : 'monosplice-native',
);

if (!fs.existsSync(binary)) {
  process.stderr.write(
    'monosplice: the native binary is missing (postinstall was skipped) — reinstall with `npm install -g monosplice`, or run: curl -fsSL https://github.com/jakequist/monosplice/releases/latest/download/install.sh | sh\n',
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`monosplice: could not run ${binary}: ${result.error.message}\n`);
  process.exit(1);
}
// Killed by a signal: no exit code to forward, so report failure.
process.exit(result.status === null ? 1 : result.status);

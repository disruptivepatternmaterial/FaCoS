#!/usr/bin/env node
'use strict';

// Drives `tests/scripted-session.txt` through parser.js as if a single nc
// session sent every line in order. Captures replies and any side-effect /
// event payloads so the harness can diff against expected output without
// depending on Docker. Layer 2 in pure Node form.

const fs   = require('fs');
const path = require('path');
const P    = require(path.join(__dirname, '..', 'parser.js'));

const lines = fs.readFileSync(path.join(__dirname, 'scripted-session.txt'), 'utf8')
  .split('\n').filter(s => s.trim().length > 0);

const state = P.defaultState();
const sessionId = 'A';
const out = [];

for (const ln of lines) {
  const r = P.handle(ln, sessionId, state);
  if (!r) continue;
  out.push(r.reply.replace(/\n+$/, ''));
  for (const ev of (r.events || [])) {
    out.push(ev.payload.replace(/\n+$/, ''));
  }
  for (const se of (r.sideEffects || [])) {
    if (se.kind === 'switch') {
      out.push('# sideEffect mqtt trains/device/' + se.addr + ' = ' + se.wire);
    } else if (se.kind === 'lokSpeed') {
      out.push('# sideEffect mqtt trains/device/' + (se.addr || se.lokId) + ' = ' + se.speed + ',' + se.dir);
    }
  }
}

process.stdout.write(out.join('\n') + '\n');

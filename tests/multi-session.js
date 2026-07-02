#!/usr/bin/env node
'use strict';

// Layer 4: two parallel sessions exercising view fan-out.
//
// Session A: subscribes to id=1 ECoS view AND id=1000 lok view.
// Session B: sends mutating commands.
// Verify:
//   - A receives the EVENT 1 status[STOP] payload after B's set(1, stop).
//   - A receives the EVENT 1000 speedstep[14] dir[1] after B's set(1000, ...).
//   - A's tcp-out routing key (msg._session.id) is "A", not B.
//   - B does NOT receive the events (it's not a viewer).
// In production this requires the per-session fan-out node in flow.json. The
// parser already emits one event message per subscriber, with msg._session.id
// pre-set, so the assertion runs over parser output directly.

const path = require('path');
const P    = require(path.join(__dirname, '..', 'parser.js'));

let failed = 0;
function check(label, ok) {
  if (ok) { console.log('  ok: ' + label); return; }
  console.log('  FAIL: ' + label);
  failed++;
}

const state = P.defaultState();

// A subscribes
P.handle('request(1, view)', 'A', state);
P.handle('request(1000, view)', 'A', state);

// B mutates
const r1 = P.handle('set(1, stop)', 'B', state);
check('set(1,stop) returns OK', /<END 0 \(OK\)>/.test(r1.reply));
check('set(1,stop) emits 1 event', r1.events.length === 1);
const ev1 = r1.events[0];
check('event subscribers includes A only', JSON.stringify(ev1.subscribers) === '["A"]');
check('event payload contains status[STOP]', /1 status\[STOP\]/.test(ev1.payload));

const r2 = P.handle('set(1000, speedstep[14], dir[1])', 'B', state);
check('set(1000,...) returns OK', /<END 0 \(OK\)>/.test(r2.reply));
check('set(1000,...) emits 1 event', r2.events.length === 1);
const ev2 = r2.events[0];
check('event subscribers is A only', JSON.stringify(ev2.subscribers) === '["A"]');
check('event payload contains speedstep[14]', /1000 speedstep\[14\]/.test(ev2.payload));
check('event payload contains dir[1]', /1000 dir\[1\]/.test(ev2.payload));

// Now A also takes control of 1000, then B's set should fail with NOCONTROL.
P.handle('request(1000, control)', 'A', state);
const r3 = P.handle('set(1000, speedstep[5])', 'B', state);
check('non-controlling B blocked', /<END 25 \(NERROR_NOCONTROL\)>/.test(r3.reply));

// A releases control; B can drive again
P.handle('release(1000, control)', 'A', state);
const r4 = P.handle('set(1000, speedstep[5])', 'B', state);
check('after release, B can drive', /<END 0 \(OK\)>/.test(r4.reply));

if (failed) {
  console.log('FAIL Layer 4: ' + failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('PASS Layer 4');

'use strict';

// Layer 1 unit tests for parser.js.
// Plain Node, no deps. Run with `node tests/parser-unit.js`.

const path = require('path');
const P = require(path.join(__dirname, '..', 'parser.js'));

let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; return; }
  failed++;
  failures.push({ label, actual: a, expected: b });
}

function startsWith(actual, prefix, label) {
  if (typeof actual === 'string' && actual.startsWith(prefix)) { passed++; return; }
  failed++;
  failures.push({ label, actual, expected: 'starts with ' + prefix });
}

function contains(actual, needle, label) {
  if (typeof actual === 'string' && actual.indexOf(needle) !== -1) { passed++; return; }
  failed++;
  failures.push({ label, actual, expected: 'contains ' + needle });
}

// ---------- Tokenizer ----------
eq(P.tokenize('get(1, info)'), {
  cmd: 'get', id: 1, options: [{ name: 'info', args: [] }],
}, 'get(1, info)');

eq(P.tokenize('get(1,info)'), {
  cmd: 'get', id: 1, options: [{ name: 'info', args: [] }],
}, 'get(1,info) no spaces');

eq(P.tokenize('set(1000, speedstep[14], dir[1])'), {
  cmd: 'set', id: 1000, options: [
    { name: 'speedstep', args: [{ kind: 'token', value: '14' }] },
    { name: 'dir', args: [{ kind: 'token', value: '1' }] },
  ],
}, 'set with two options');

eq(P.tokenize('set(1000, name["Big Boy"])'), {
  cmd: 'set', id: 1000, options: [
    { name: 'name', args: [{ kind: 'string', value: 'Big Boy' }] },
  ],
}, 'quoted string');

eq(P.tokenize('set(1000, name["Big, Boy"])'), {
  cmd: 'set', id: 1000, options: [
    { name: 'name', args: [{ kind: 'string', value: 'Big, Boy' }] },
  ],
}, 'quoted string with comma');

eq(P.tokenize('set(1000, name["Big ""Boy"" engine"])'), {
  cmd: 'set', id: 1000, options: [
    { name: 'name', args: [{ kind: 'string', value: 'Big "Boy" engine' }] },
  ],
}, 'quoted string with escaped quotes');

eq(P.tokenize('set(11, switch[DCC4g])'), {
  cmd: 'set', id: 11, options: [
    { name: 'switch', args: [{ kind: 'token', value: 'DCC4g' }] },
  ],
}, 'switch arg');

eq(P.tokenize('queryObjects(10, name, addr)'), {
  cmd: 'queryObjects', id: 10, options: [
    { name: 'name', args: [] },
    { name: 'addr', args: [] },
  ],
}, 'queryObjects with multiple bare options');

eq(P.tokenize('queryObjects(10, nr[0,3])'), {
  cmd: 'queryObjects', id: 10, options: [
    { name: 'nr', args: [
      { kind: 'token', value: '0' },
      { kind: 'token', value: '3' },
    ] },
  ],
}, 'queryObjects with nr range');

// missing close bracket (must throw)
try {
  P.tokenize('set(11, switch[DCC4g');
  failed++; failures.push({ label: 'missing ] should throw', actual: 'no throw', expected: 'throw' });
} catch (e) { passed++; }

// unknown command syntax: missing open paren
try {
  P.tokenize('set 1000');
  failed++; failures.push({ label: 'missing ( should throw', actual: 'no throw', expected: 'throw' });
} catch (e) { passed++; }

// ---------- handle: id=1 ECoS ----------
const s1 = P.defaultState();
const r1 = P.handle('get(1, info)', 'sessA', s1);
contains(r1.reply, '<REPLY get(1, info)>', 'get(1,info) header');
contains(r1.reply, '1 ProtocolVersion[', 'get(1,info) protocol line');
contains(r1.reply, '<END 0 (OK)>', 'get(1,info) end ok');

const r1b = P.handle('get(1, status)', 'sessA', s1);
contains(r1b.reply, '1 status[GO]', 'initial status GO');

const r1c = P.handle('set(1, stop)', 'sessB', s1);
contains(r1c.reply, '<REPLY set(1, stop)>', 'set(1,stop) reply');
eq(s1.status, 'STOP', 'state.status STOP');
// no viewers yet, so no events
eq(r1c.events.length, 0, 'no viewers no event');

const r1d = P.handle('request(1, view)', 'sessA', s1);
contains(r1d.reply, '<END 0 (OK)>', 'request(1,view) ok');
const r1e = P.handle('set(1, go)', 'sessB', s1);
eq(s1.status, 'GO', 'state.status GO');
eq(r1e.events.length, 1, 'one event after status change');
contains(r1e.events[0].payload, '1 status[GO]', 'event body GO');
eq(r1e.events[0].subscribers, ['sessA'], 'event subscribers');

// ---------- handle: bad command ----------
const sErr = P.defaultState();
const rBad = P.handle('frobnicate(1)', 'sessA', sErr);
contains(rBad.reply, '<END 15 (NERROR_BADPARAMETER)>', 'unknown verb -> 15');

const rBad2 = P.handle('set(11, switch', 'sessA', sErr);
contains(rBad2.reply, '<END 15 (NERROR_BADPARAMETER)>', 'unbalanced -> 15');

const rNoObj = P.handle('get(7777, foo)', 'sessA', sErr);
contains(rNoObj.reply, '<END 19 (NERROR_NOOBJECT)>', 'unknown id class -> 19');

// ---------- handle: lok ----------
const s2 = P.defaultState();
const r2a = P.handle('get(1000, name)', 'sessA', s2);
contains(r2a.reply, '1000 name["Fake Locomotive 1000"]', 'lok name read');

const r2b = P.handle('get(1000, addr, protocol, speedstep, dir)', 'sessA', s2);
contains(r2b.reply, '1000 addr[3]', 'lok multi-get addr');
contains(r2b.reply, '1000 protocol[DCC28]', 'lok multi-get proto');
contains(r2b.reply, '1000 speedstep[0]', 'lok multi-get speedstep');
contains(r2b.reply, '1000 dir[0]', 'lok multi-get dir');

P.handle('request(1000, view)', 'sessV', s2);
const r2c = P.handle('set(1000, speedstep[14], dir[1])', 'sessA', s2);
contains(r2c.reply, '<END 0 (OK)>', 'set speed ok');
eq(s2.loks[1000].speedstep, 14, 'speedstep set');
eq(s2.loks[1000].dir, 1, 'dir set');
eq(r2c.sideEffects.length, 1, 'one side effect for speed');
eq(r2c.sideEffects[0], { kind: 'lokSpeed', lokId: 1000, addr: 3, speed: 14, dir: 1 }, 'speed side effect content');
eq(r2c.events.length, 1, 'one event for viewers');
contains(r2c.events[0].payload, '1000 speedstep[14]', 'event body speedstep');
contains(r2c.events[0].payload, '1000 dir[1]', 'event body dir');

// func read/write
P.handle('set(1000, func[3, 1])', 'sessA', s2);
eq(s2.loks[1000].funcs[3], 1, 'func 3 set to 1');
const r2d = P.handle('get(1000, func[3])', 'sessA', s2);
contains(r2d.reply, '1000 func[3, 1]', 'func 3 reads back');

// cv: unset cv returns BADPARAMETER (no fabrication)
const r2cv = P.handle('get(1000, cv[7])', 'sessA', s2);
contains(r2cv.reply, '<END 15 (NERROR_BADPARAMETER)>', 'unset cv -> 15');
P.handle('set(1000, cv[7, 42])', 'sessA', s2);
const r2cv2 = P.handle('get(1000, cv[7])', 'sessA', s2);
contains(r2cv2.reply, '1000 cv[7, 42]', 'cv read after set');

// protocols: all 8 valid
for (const p of ['MM14','MM27','MM28','DCC14','DCC28','DCC128','SX32','MMFKT']) {
  const sP = P.defaultState();
  const rp = P.handle(`set(1000, protocol[${p}])`, 'sessA', sP);
  contains(rp.reply, '<END 0 (OK)>', 'protocol ' + p + ' ok');
  eq(sP.loks[1000].protocol, p, 'protocol ' + p + ' stored');
}
const sBadP = P.defaultState();
const rBadP = P.handle('set(1000, protocol[FOO])', 'sessA', sBadP);
contains(rBadP.reply, '<END 15 (NERROR_BADPARAMETER)>', 'invalid protocol -> 15');

// ---------- handle: control semantics ----------
const sC = P.defaultState();
P.handle('request(1000, control)', 'sessOwner', sC);
const rOther = P.handle('set(1000, speedstep[5])', 'sessOther', sC);
contains(rOther.reply, '<END 25 (NERROR_NOCONTROL)>', 'other session blocked');
const rForce = P.handle('request(1000, control, force)', 'sessOther', sC);
contains(rForce.reply, '<END 0 (OK)>', 'force takeover ok');
eq(sC.controls[1000], 'sessOther', 'control transferred');

// ---------- handle: SwMgr switch[..] side effect ----------
const sSw = P.defaultState();
P.handle('request(11, view, viewswitch)', 'sessA', sSw);
const rSw = P.handle('set(11, switch[DCC4g])', 'sessA', sSw);
contains(rSw.reply, '<END 0 (OK)>', 'set switch ok');
eq(rSw.sideEffects.length, 1, 'one side effect');
eq(rSw.sideEffects[0], { kind: 'switch', protocol: 'DCC', addr: 4, wire: 'g' }, 'switch side effect');
eq(rSw.events.length, 1, 'one event for viewers');
contains(rSw.events[0].payload, '11 switch[DCC4g]', 'switch event body');
const rSwR = P.handle('set(11, switch[DCC4r])', 'sessA', sSw);
eq(rSwR.sideEffects[0].wire, 'r', 'switch r');
const rSwM = P.handle('set(11, switch[MOT5g])', 'sessA', sSw);
eq(rSwM.sideEffects[0], { kind: 'switch', protocol: 'MOT', addr: 5, wire: 'g' }, 'switch MOT 5 g');

// ---------- handle: feedback / ECoSDetector ----------
const sF = P.defaultState();
const rF1 = P.handle('queryObjects(26)', 'sessA', sF);
contains(rF1.reply, '200', 'queryObjects 26 lists 200');
const rF2 = P.handle('queryObjects(26, ports)', 'sessA', sF);
contains(rF2.reply, '200 ports[2]', 'queryObjects 26 ports');
const rF3 = P.handle('get(26, size)', 'sessA', sF);
contains(rF3.reply, '26 size[1]', 'fbmgr size 1');
P.handle('request(200, view)', 'sessA', sF);
const rF4 = P.handle('get(200, state)', 'sessA', sF);
contains(rF4.reply, '200 state[0x0]', 'detector initial state hex');
const rF5 = P.handle('get(200, railcom[0])', 'sessA', sF);
contains(rF5.reply, '200 railcom[00, 0000, 0]', 'railcom default zero');
const rF6 = P.handle('get(200, railcom[1])', 'sessA', sF);
contains(rF6.reply, '200 railcom[01, 0000, 0]', 'railcom port 1');

// ---------- handle: queryObjects with name filter ----------
const sQ = P.defaultState();
const rQ = P.handle('queryObjects(10, name)', 'sessA', sQ);
contains(rQ.reply, '1000 name["Fake Locomotive 1000"]', 'queryObjects 10 name');

// ---------- framer ----------
const buf = {};
const f1 = P.feedFrame(buf, 'sx', 'get(1, info)\n');
eq(f1, ['get(1, info)'], 'framer single complete');
const f2 = P.feedFrame(buf, 'sx', 'get(1, status)\nget(');
eq(f2, ['get(1, status)'], 'framer keeps partial');
const f3 = P.feedFrame(buf, 'sx', '1, status)\n');
eq(f3, ['get(1, status)'], 'framer completes partial');
const f4 = P.feedFrame(buf, 'sx', 'a\nb\nc\n');
eq(f4, ['a', 'b', 'c'], 'framer multiple in one read');
const f5 = P.feedFrame(buf, 'sx', 'a\r\nb\r\n');
eq(f5, ['a', 'b'], 'framer strips CR');

// ---------- summary ----------
console.log(`PASS: ${passed}`);
console.log(`FAIL: ${failed}`);
if (failed) {
  for (const f of failures) {
    console.log('--');
    console.log('  label:    ' + f.label);
    console.log('  actual:   ' + JSON.stringify(f.actual));
    console.log('  expected: ' + JSON.stringify(f.expected));
  }
  process.exit(1);
}

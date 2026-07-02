#!/usr/bin/env node
'use strict';

// Build FaCoS/flow.json from the canonical pieces:
//   - parser.js (inlined into the parser function-node body)
//   - layout-map.json + connection.json (loaded at runtime)
//   - the 4 byte-identical sidewire keepers, lifted verbatim from the
//     production export (see tools/keepers.json).
//
// Run: node tools/build-flow.js
//
// Output: ../flow.json

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const PARSER_JS = fs.readFileSync(path.join(ROOT, 'parser.js'), 'utf8');
const KEEPERS   = JSON.parse(fs.readFileSync(path.join(__dirname, 'keepers.json'), 'utf8'));

const TAB           = 'ae42528ac326c82b';
const MQTT_BROKER   = '4e91dd5ffb6a9ee8';
const HA_SERVER     = '85b918fc1d4c8834';

const TCP_IN_ID     = '953ba978a781e9fe';
const TCP_OUT_ID    = '0583f2c2bfaaf73d';
const MQTT_OUT_ID   = '6d6000f15fe09e73';

const FRAMER_ID     = 'fa1e6a01b0f10001';
const PARSER_ID     = 'fa1e6a01b0f10002';
const REPLY_OUT_ID  = 'fa1e6a01b0f10003';
const SE_LINK_ID    = 'fa1e6a01b0f10004';
const SE_RECV_ID    = 'fa1e6a01b0f10005';
const SE_DISP_ID    = 'fa1e6a01b0f10006';
const EVT_LINK_ID   = 'fa1e6a01b0f10007';
const EVT_RECV_ID   = 'fa1e6a01b0f10008';
const EVT_FANOUT_ID = 'fa1e6a01b0f10009';
const HA_FB_LINK_ID = 'fa1e6a01b0f1000a';
const HA_FB_RECV_ID = 'fa1e6a01b0f1000b';
const TRACE_FILE_ID = 'fa1e6a01b0f1000c';
const TRACE_GATE_ID = 'fa1e6a01b0f1000d';
const TRACE_TOG_ID  = 'fa1e6a01b0f1000e';
const TRACE_INJECT  = 'fa1e6a01b0f1000f';
const BOOT_INJECT   = 'fa1e6a01b0f10010';
const BOOT_INIT_ID  = 'fa1e6a01b0f10011';
const LAYOUT_INJ    = 'fa1e6a01b0f10012';
const LAYOUT_FILE   = 'fa1e6a01b0f10013';
const LAYOUT_JSON   = 'fa1e6a01b0f10014';
const LAYOUT_SET    = 'fa1e6a01b0f10015';
const CONN_INJ      = 'fa1e6a01b0f10016';
const CONN_FILE     = 'fa1e6a01b0f10017';
const CONN_JSON     = 'fa1e6a01b0f10018';
const CONN_SET      = 'fa1e6a01b0f10019';
const SE_TO_OLD_ID  = 'fa1e6a01b0f1001a';
const TRACE_DBG_ID  = 'fa1e6a01b0f1001b';
const UNHANDLED_DBG = 'fa1e6a01b0f1001c';
const SMOKE_INJ_GO  = 'fa1e6a01b0f1001d';
const SMOKE_INJ_ST  = 'fa1e6a01b0f1001e';
const SMOKE_INJ_LK  = 'fa1e6a01b0f1001f';
const SMOKE_INJ_SW  = 'fa1e6a01b0f10020';
const SMOKE_INJ_RC  = 'fa1e6a01b0f10021';
const COMMENT_HDR   = 'fa1e6a01b0f10022';
const SES_INJECT    = 'fa1e6a01b0f10023';
const SE_LOK_ID     = 'fa1e6a01b0f10024';
const SE_SW_ID      = 'fa1e6a01b0f10025';

// ---------------------------------------------------------------------------
// Function-node bodies
// ---------------------------------------------------------------------------

const PARSER_BODY = `
${PARSER_JS.replace(/^'use strict';\s*/, '').replace(/if \(typeof module !== 'undefined'[\s\S]+$/m, '')}

// -- Function-node entry point --
const sessionId = (msg._session && msg._session.id) || 'default';
let state = flow.get('facos');
if (!state) { state = defaultState(); flow.set('facos', state); }

const result = handle(msg.payload, sessionId, state);
if (!result) { return null; }

const replyMsg = {
  _session: msg._session,
  payload: result.reply,
  _facos: { raw: result.raw, summary: '<REPLY ' + result.raw + '> ' + (result.parsed && result.parsed.cmd) + ':' + (result.parsed && result.parsed.id) },
};

const sideEffectMsgs = [];
for (const se of (result.sideEffects || [])) {
  if (se.kind === 'switch') {
    sideEffectMsgs.push({
      raw:     { address: String(se.addr), wire: se.wire },
      _facosKind: 'switch',
    });
  } else if (se.kind === 'lokSpeed') {
    sideEffectMsgs.push({
      raw:     { address: String(se.addr || se.lokId), speed: String(se.speed), dir: String(se.dir) },
      _facosKind: 'lokSpeed',
    });
  }
}

const eventMsgs = [];
for (const ev of (result.events || [])) {
  for (const sid of (ev.subscribers || [])) {
    eventMsgs.push({
      _session: { type: 'tcp', id: sid },
      payload: ev.payload,
      _facos: { kind: 'event', summary: ev.payload.split('\\n')[0] },
    });
  }
}

const traceMsg = {
  payload: new Date().toISOString() + '\\t' + sessionId + '\\t' + JSON.stringify(result.raw) + '\\t' + (result.parsed ? result.parsed.cmd + ':' + result.parsed.id : 'PARSE_FAIL') + '\\n',
  _facos: { kind: 'trace' },
};

const unhandled = (!result.parsed || result.reply.indexOf('NERROR_BADPARAMETER') !== -1 || result.reply.indexOf('NERROR_NOOBJECT') !== -1)
  ? { payload: { raw: result.raw, reply: result.reply, parsed: result.parsed } }
  : null;

return [replyMsg, sideEffectMsgs, eventMsgs, traceMsg, unhandled];
`;

const FRAMER_BODY = `
const sid = (msg._session && msg._session.id) || 'default';
let bag = flow.get('facosBuf');
if (!bag) { bag = {}; flow.set('facosBuf', bag); }
const prev = bag[sid] || '';
const combined = prev + String(msg.payload);
const parts = combined.split('\\n');
const tail = parts.pop();
bag[sid] = tail;
const out = [];
for (const p of parts) {
  const cleaned = p.replace(/\\r+$/, '').trim();
  if (!cleaned) continue;
  out.push({ _session: msg._session, payload: cleaned });
}
return [out];
`;

const SE_DISPATCH_BODY = `
const k = msg._facosKind;
if (k === 'switch')   return [msg, null];
if (k === 'lokSpeed') return [null, msg];
return [null, null];
`;

// Drop msg._facosKind / _facos so payload looks identical to legacy chain.
const SE_LOK_BODY = `
msg.payload = msg.raw;
delete msg.raw;
delete msg._facosKind;
delete msg._facos;
return msg;
`;

const SE_SW_BODY = `
msg.payload = msg.raw;
delete msg.raw;
delete msg._facosKind;
delete msg._facos;
return msg;
`;

// EVT_FANOUT clones one msg per subscriber. Parser already cloned; this is a
// pass-through that ensures _session.id is set per outgoing msg (handled in
// parser already). Keep as identity for clarity.
const EVT_FANOUT_BODY = `
return msg;
`;

const TRACE_GATE_BODY = `
const enabled = flow.get('facosTraceEnabled');
if (!enabled) return null;
return msg;
`;

const TRACE_TOGGLE_BODY = `
const cur = flow.get('facosTraceEnabled') || false;
flow.set('facosTraceEnabled', !cur);
node.warn('FaCoS trace ' + (!cur ? 'ENABLED' : 'DISABLED'));
return null;
`;

const BOOT_INIT_BODY = `
${PARSER_JS.replace(/^'use strict';\s*/, '').replace(/if \(typeof module !== 'undefined'[\s\S]+$/m, '')}
flow.set('facos', defaultState());
flow.set('facosBuf', {});
flow.set('facosTraceEnabled', false);
return msg;
`;

const LAYOUT_SET_BODY = `
let st = flow.get('facos') || defaultState();
st.layout = msg.payload;
flow.set('facos', st);
return null;
`;

const CONN_SET_BODY = `
let st = flow.get('facos') || {};
st.conn = msg.payload;
flow.set('facos', st);
return null;
`;

// ---------------------------------------------------------------------------
// Build node list
// ---------------------------------------------------------------------------

const nodes = [];

nodes.push({
  id: TAB, type: 'tab', label: 'FaCoS', disabled: false, info: '',
  env: [],
});

nodes.push({
  id: COMMENT_HDR, type: 'comment', z: TAB,
  name: 'FaCoS - Fake ECoS PC-Interface (see README.md)',
  info:
    'Verification commands:\n' +
    '  jq empty flow.json                                            # JSON valid\n' +
    '  node tests/parser-unit.js                                     # parser layer\n' +
    '  bash tests/run-tests.sh                                       # tcp roundtrip\n' +
    '  bash tests/diff-sidewires.sh                                  # sidewire byte check\n' +
    '\n' +
    'See SPEC-NOTES.md for the §-by-§ mapping to handlers.\n',
  x: 220, y: 60, wires: [],
});

// --- Boot / init chain ---
nodes.push({
  id: BOOT_INJECT, type: 'inject', z: TAB, name: 'boot facos',
  props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
  repeat: '', crontab: '', once: true, onceDelay: '0.1',
  topic: '', payload: '', payloadType: 'date',
  x: 180, y: 140, wires: [[BOOT_INIT_ID]],
});

nodes.push({
  id: BOOT_INIT_ID, type: 'function', z: TAB, name: 'init flow.facos',
  func: BOOT_INIT_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 380, y: 140, wires: [[]],
});

// --- Layout-map loader ---
nodes.push({
  id: LAYOUT_INJ, type: 'inject', z: TAB, name: 'load layout-map',
  props: [{ p: 'payload' }],
  repeat: '', crontab: '', once: true, onceDelay: '1',
  topic: '', payload: '', payloadType: 'date',
  x: 180, y: 180, wires: [[LAYOUT_FILE]],
});
nodes.push({
  id: LAYOUT_FILE, type: 'file in', z: TAB, name: 'layout-map.json',
  filename: 'projects/bowman-mtn-node-red/FaCoS/layout-map.json',
  filenameType: 'str', format: 'utf8', chunk: false, sendError: false,
  encoding: 'none', allProps: false,
  x: 400, y: 180, wires: [[LAYOUT_JSON]],
});
nodes.push({
  id: LAYOUT_JSON, type: 'json', z: TAB, name: '', property: 'payload',
  action: 'obj', pretty: false,
  x: 600, y: 180, wires: [[LAYOUT_SET]],
});
nodes.push({
  id: LAYOUT_SET, type: 'function', z: TAB, name: 'set flow.facos.layout',
  func: LAYOUT_SET_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 820, y: 180, wires: [[]],
});

// --- Connection-config loader (port, mqtt prefix, trace path) ---
nodes.push({
  id: CONN_INJ, type: 'inject', z: TAB, name: 'load connection',
  props: [{ p: 'payload' }],
  repeat: '', crontab: '', once: true, onceDelay: '1.2',
  topic: '', payload: '', payloadType: 'date',
  x: 180, y: 220, wires: [[CONN_FILE]],
});
nodes.push({
  id: CONN_FILE, type: 'file in', z: TAB, name: 'connection.json',
  filename: 'projects/bowman-mtn-node-red/FaCoS/connection.json',
  filenameType: 'str', format: 'utf8', chunk: false, sendError: false,
  encoding: 'none', allProps: false,
  x: 400, y: 220, wires: [[CONN_JSON]],
});
nodes.push({
  id: CONN_JSON, type: 'json', z: TAB, name: '', property: 'payload',
  action: 'obj', pretty: false,
  x: 600, y: 220, wires: [[CONN_SET]],
});
nodes.push({
  id: CONN_SET, type: 'function', z: TAB, name: 'set flow.facos.conn',
  func: CONN_SET_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 820, y: 220, wires: [[]],
});

// --- Trace toggle ---
nodes.push({
  id: TRACE_INJECT, type: 'inject', z: TAB, name: 'toggle trace log',
  props: [{ p: 'payload' }],
  repeat: '', crontab: '', once: false, onceDelay: 0.1,
  topic: '', payload: '', payloadType: 'date',
  x: 180, y: 260, wires: [[TRACE_TOG_ID]],
});
nodes.push({
  id: TRACE_TOG_ID, type: 'function', z: TAB, name: 'toggle facosTraceEnabled',
  func: TRACE_TOGGLE_BODY,
  outputs: 0, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 420, y: 260, wires: [],
});

// --- TCP path: in -> framer -> parser -> reply -> tcp out ---
nodes.push({
  id: TCP_IN_ID, type: 'tcp in', z: TAB, name: '',
  server: 'server', host: '', port: '15471',
  datamode: 'stream', datatype: 'utf8', newline: '',
  topic: '', trim: false, base64: false, tls: '',
  x: 180, y: 360, wires: [[FRAMER_ID]],
});

nodes.push({
  id: FRAMER_ID, type: 'function', z: TAB, name: 'framer (per-session line buf)',
  func: FRAMER_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 400, y: 360, wires: [[PARSER_ID]],
});

nodes.push({
  id: PARSER_ID, type: 'function', z: TAB,
  name: 'parser/dispatcher/formatter',
  func: PARSER_BODY,
  outputs: 5, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 660, y: 360,
  wires: [
    [TCP_OUT_ID, TRACE_GATE_ID],          // 0: replies
    [SE_DISP_ID],                          // 1: side effects
    [EVT_LINK_ID],                         // 2: events
    [TRACE_GATE_ID],                       // 3: trace
    [UNHANDLED_DBG],                       // 4: unhandled debug
  ],
});

nodes.push({
  id: TCP_OUT_ID, type: 'tcp out', z: TAB, name: '',
  host: '', port: '', beserver: 'reply', base64: false, end: false,
  x: 940, y: 340, wires: [],
});

// --- Side-effects dispatch ---
nodes.push({
  id: SE_DISP_ID, type: 'function', z: TAB, name: 'side-effects dispatch',
  func: SE_DISPATCH_BODY,
  outputs: 2, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 880, y: 380,
  wires: [[SE_SW_ID], [SE_LOK_ID]],
});

nodes.push({
  id: SE_SW_ID, type: 'function', z: TAB,
  name: 'switch -> raw',
  func: SE_SW_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 1100, y: 360, wires: [['4e2cc9eb2ddadad8']],
});

nodes.push({
  id: SE_LOK_ID, type: 'function', z: TAB,
  name: 'lokSpeed -> raw',
  func: SE_LOK_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 1100, y: 400, wires: [['24dc6b2d70f47d9e']],
});

// --- Event fan-out (parser already clones per-subscriber) ---
nodes.push({
  id: EVT_LINK_ID, type: 'link out', z: TAB, name: 'facos.events',
  mode: 'link', links: [EVT_RECV_ID],
  x: 880, y: 420, wires: [],
});
nodes.push({
  id: EVT_RECV_ID, type: 'link in', z: TAB, name: 'facos.events.in',
  links: [EVT_LINK_ID, HA_FB_LINK_ID],
  x: 200, y: 460, wires: [[EVT_FANOUT_ID]],
});
nodes.push({
  id: EVT_FANOUT_ID, type: 'function', z: TAB, name: 'event fan-out',
  func: EVT_FANOUT_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 420, y: 460, wires: [[TCP_OUT_ID, TRACE_GATE_ID]],
});

// --- Trace logger ---
nodes.push({
  id: TRACE_GATE_ID, type: 'function', z: TAB, name: 'trace gate',
  func: TRACE_GATE_BODY,
  outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
  x: 920, y: 540, wires: [[TRACE_FILE_ID, TRACE_DBG_ID]],
});
nodes.push({
  id: TRACE_FILE_ID, type: 'file', z: TAB, name: 'cursor-scratch/facos-trace.log',
  filename: 'cursor-scratch/facos-trace.log', filenameType: 'str',
  appendNewline: true, createDir: true, overwriteFile: 'false',
  encoding: 'none',
  x: 1200, y: 520, wires: [[]],
});
nodes.push({
  id: TRACE_DBG_ID, type: 'debug', z: TAB, name: 'trace',
  active: false, tosidebar: true, console: false, tostatus: false,
  complete: 'payload', targetType: 'msg', statusVal: '', statusType: 'auto',
  x: 1180, y: 560, wires: [],
});

nodes.push({
  id: UNHANDLED_DBG, type: 'debug', z: TAB, name: 'unhandled',
  active: true, tosidebar: true, console: false, tostatus: false,
  complete: 'payload', targetType: 'msg', statusVal: '', statusType: 'auto',
  x: 880, y: 460, wires: [],
});

// --- HA feedback bridge: function 114 emits EVENT 200 already, route to events ---
nodes.push({
  id: HA_FB_LINK_ID, type: 'link out', z: TAB, name: 'facos.haFeedback',
  mode: 'link', links: [EVT_RECV_ID],
  x: 1320, y: 700, wires: [],
});

// --- Smoke / test inject buttons (replaces the noisy duplicate set) ---
nodes.push({
  id: SMOKE_INJ_GO, type: 'inject', z: TAB, name: 'smoke get(1,info)',
  props: [{ p: 'payload', v: 'get(1,info)\n', vt: 'str' }, { p: '_session', v: '{"type":"tcp","id":"smoke"}', vt: 'json' }],
  repeat: '', crontab: '', once: false, onceDelay: 0.1,
  topic: '', payload: '', payloadType: 'date',
  x: 200, y: 800, wires: [[FRAMER_ID]],
});
nodes.push({
  id: SMOKE_INJ_ST, type: 'inject', z: TAB, name: 'smoke get(1,status)',
  props: [{ p: 'payload', v: 'get(1,status)\n', vt: 'str' }, { p: '_session', v: '{"type":"tcp","id":"smoke"}', vt: 'json' }],
  repeat: '', crontab: '', once: false, onceDelay: 0.1,
  topic: '', payload: '', payloadType: 'date',
  x: 200, y: 840, wires: [[FRAMER_ID]],
});
nodes.push({
  id: SMOKE_INJ_LK, type: 'inject', z: TAB, name: 'smoke set(1000,speedstep[14],dir[1])',
  props: [{ p: 'payload', v: 'set(1000,speedstep[14],dir[1])\n', vt: 'str' }, { p: '_session', v: '{"type":"tcp","id":"smoke"}', vt: 'json' }],
  repeat: '', crontab: '', once: false, onceDelay: 0.1,
  topic: '', payload: '', payloadType: 'date',
  x: 240, y: 880, wires: [[FRAMER_ID]],
});
nodes.push({
  id: SMOKE_INJ_SW, type: 'inject', z: TAB, name: 'smoke set(11,switch[DCC4g])',
  props: [{ p: 'payload', v: 'set(11,switch[DCC4g])\n', vt: 'str' }, { p: '_session', v: '{"type":"tcp","id":"smoke"}', vt: 'json' }],
  repeat: '', crontab: '', once: false, onceDelay: 0.1,
  topic: '', payload: '', payloadType: 'date',
  x: 220, y: 920, wires: [[FRAMER_ID]],
});
nodes.push({
  id: SMOKE_INJ_RC, type: 'inject', z: TAB, name: 'smoke get(200,railcom[0])',
  props: [{ p: 'payload', v: 'get(200,railcom[0])\n', vt: 'str' }, { p: '_session', v: '{"type":"tcp","id":"smoke"}', vt: 'json' }],
  repeat: '', crontab: '', once: false, onceDelay: 0.1,
  topic: '', payload: '', payloadType: 'date',
  x: 220, y: 960, wires: [[FRAMER_ID]],
});

// --- Sidewire keepers (BYTE-IDENTICAL func/rules, may have new wires) ---

// 1. dir 0,0 / dir 0,1 changes (preserved verbatim; no inputs in new flow)
nodes.push(KEEPERS['160be93ff00baee4']);
nodes.push(KEEPERS['affe2618d7b80853']);

// 2. accessory handler chain
nodes.push(KEEPERS['27d8ff35b4e13404']);
nodes.push(KEEPERS['4e2cc9eb2ddadad8']);
nodes.push(KEEPERS['7485938bd6ccdaec']);

// 3. MQTT-to-HA bridge
nodes.push(KEEPERS['f235fbbc2f3535a6']);
nodes.push(KEEPERS['b13bfa380f4582a8']);
nodes.push(KEEPERS['3843a287d6cf613b']);
nodes.push(KEEPERS['1bf2aa2b2ca64b87']);

// 4. function 114 (HA binary-sensor -> EVENT 200)
const fn114 = JSON.parse(JSON.stringify(KEEPERS['8759c8a437d1bfc1']));
fn114.wires = [[HA_FB_LINK_ID]];
nodes.push(fn114);

// HA inputs that drive function 114 (preserve signal source verbatim)
nodes.push(KEEPERS['cfd7460388fc6861']);
nodes.push(KEEPERS['b922981349a7ceb7']);

// MQTT out (shared infrastructure; same id as production)
nodes.push({
  id: MQTT_OUT_ID, type: 'mqtt out', z: TAB, name: '',
  topic: '', qos: '0', retain: 'true', respTopic: '',
  contentType: '', userProps: '', correl: '', expiry: '',
  broker: MQTT_BROKER,
  x: 1500, y: 380, wires: [],
});

// `set(1, stop)` and `set(1, go)` test injects (smoke for status events)
nodes.push({
  id: SES_INJECT, type: 'inject', z: TAB, name: 'smoke set(1,stop) & go',
  props: [{ p: 'payload', v: 'set(1,stop)\nset(1,go)\n', vt: 'str' }, { p: '_session', v: '{"type":"tcp","id":"smoke"}', vt: 'json' }],
  repeat: '', crontab: '', once: false, onceDelay: 0.1,
  topic: '', payload: '', payloadType: 'date',
  x: 220, y: 1000, wires: [[FRAMER_ID]],
});

// Patch keeper wires to point at our new chain.
// `4e2cc9eb2ddadad8` originally fans out to MQTT bridge AND legacy debug;
// preserve the MQTT path, drop the debug. New wires:
const k1 = nodes.find(n => n.id === '4e2cc9eb2ddadad8');
k1.wires = [[ '7485938bd6ccdaec' ]];
const k2 = nodes.find(n => n.id === '7485938bd6ccdaec');
k2.wires = [[ MQTT_OUT_ID ]];
const k3 = nodes.find(n => n.id === '160be93ff00baee4');
k3.wires = [[ MQTT_OUT_ID ]];
const k4 = nodes.find(n => n.id === 'affe2618d7b80853');
k4.wires = [[ MQTT_OUT_ID ]];
const k5 = nodes.find(n => n.id === 'b13bfa380f4582a8');
k5.wires = [[ '3843a287d6cf613b' ], [ '1bf2aa2b2ca64b87' ], [] ];
const k6 = nodes.find(n => n.id === '3843a287d6cf613b');
k6.wires = [[]];
const k7 = nodes.find(n => n.id === '1bf2aa2b2ca64b87');
k7.wires = [[]];
const k8 = nodes.find(n => n.id === 'f235fbbc2f3535a6');
k8.wires = [[ 'b13bfa380f4582a8' ]];
const k9 = nodes.find(n => n.id === 'cfd7460388fc6861');
k9.wires = [[ '8759c8a437d1bfc1' ]];
const k10 = nodes.find(n => n.id === 'b922981349a7ceb7');
k10.wires = [[ '8759c8a437d1bfc1' ]];
const k11 = nodes.find(n => n.id === '27d8ff35b4e13404');
// keep input-format-compatibility but route to the same chain we already use
k11.wires = [[ '4e2cc9eb2ddadad8' ]];

// Patch lokSpeed sidewire `24dc6b2d70f47d9e`-bound. We did NOT pull this into
// keepers.json (it's part of the speed-handler chain, not the 4 byte-identical
// wires). Bring it in verbatim now.
nodes.push(KEEPERS['24dc6b2d70f47d9e']);
const klok = nodes.find(n => n.id === '24dc6b2d70f47d9e');
klok.wires = [[ '4721cdc23d5f9473' ]];
nodes.push(KEEPERS['4721cdc23d5f9473']);
const klok2 = nodes.find(n => n.id === '4721cdc23d5f9473');
klok2.wires = [[ MQTT_OUT_ID ]];

// ---------------------------------------------------------------------------
// Write out
// ---------------------------------------------------------------------------

const out = JSON.stringify(nodes, null, 4) + '\n';
fs.writeFileSync(path.join(ROOT, 'flow.json'), out);
console.log('wrote ' + path.join(ROOT, 'flow.json') + '  nodes=' + nodes.length);

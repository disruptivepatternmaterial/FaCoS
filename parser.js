'use strict';

// FaCoS ECoS PC-Interface command parser.
//
// Single source of truth for tokenizing, dispatching, and formatting replies
// for the ESU PC-Interface protocol (spec v0.2 / §7) plus the JMRI / Rocrail
// superset that real clients emit on the wire.
//
// Two consumers:
//   1. `tests/parser-unit.js` `require()`s this directly under Node.
//   2. `flow.json`'s parser function node has this file's body inlined verbatim
//      (the function-node body strips the trailing `module.exports` block).
//
// The handler signature is intentionally pure: it takes (rawFrame, sessionId,
// state) and returns { reply, sideEffects, events, raw, parsed }. The flow
// node mutates `state` (which is the `flow.facos` flow-context object) in
// place, then routes the returned arrays to the side-effect / fan-out wires.

// -- Error codes (spec §5 + JMRI's NetworkErrorCodes table) --
const ERR = {
  OK:              { code: 0,  name: 'OK' },
  BADPARAMETER:    { code: 15, name: 'NERROR_BADPARAMETER' },
  NOOBJECT:        { code: 19, name: 'NERROR_NOOBJECT' },
  NOPARAMETER:     { code: 20, name: 'NERROR_NOPARAMETER' },
  NOCONTROL:       { code: 25, name: 'NERROR_NOCONTROL' },
  NOAPPEND:        { code: 27, name: 'NERROR_NOAPPEND' },
  NOAPPEND35:      { code: 35, name: 'NERROR_NOAPPEND' },
};

const VALID_PROTOCOLS = new Set([
  'MM14', 'MM27', 'MM28', 'DCC14', 'DCC28', 'DCC128', 'SX32', 'MMFKT',
]);

// -------------------------------------------------------------------------
// Tokenizer / parser
// -------------------------------------------------------------------------
// Grammar (per ESU spec §5):
//   command   := name '(' id (',' option)* ')'
//   option    := name | name '[' arg (',' arg)* ']'
//   arg       := bareword | quoted
//   quoted    := '"' (any | '""')* '"'
//
// Whitespace inside parens is permitted. iTrain emits no whitespace; JMRI
// emits ', '. Both must round-trip.
//
// `tokenize` returns { cmd, id, options } or throws SyntaxError. The error
// message is propagated as `<END 15 (NERROR_BADPARAMETER)>` by the caller.

function tokenize(input) {
  if (typeof input !== 'string') {
    throw new SyntaxError('input must be string');
  }
  const s = input.replace(/[\r\n]+$/, '');
  let i = 0;

  function skipSpace() {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  }

  skipSpace();
  let cmd = '';
  while (i < s.length && /[A-Za-z]/.test(s[i])) cmd += s[i++];
  if (!cmd) throw new SyntaxError('missing command name');
  skipSpace();
  if (s[i] !== '(') throw new SyntaxError("expected '('");
  i++;
  skipSpace();

  let idStr = '';
  while (i < s.length && /[0-9]/.test(s[i])) idStr += s[i++];
  if (!idStr) throw new SyntaxError('missing id');
  const id = parseInt(idStr, 10);
  skipSpace();

  const options = [];
  while (s[i] === ',') {
    i++;
    skipSpace();
    let name = '';
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) name += s[i++];
    if (!name) throw new SyntaxError('missing option name');
    skipSpace();
    const args = [];
    if (s[i] === '[') {
      i++;
      skipSpace();
      if (s[i] === ']') {
        i++;
      } else {
        while (true) {
          let arg;
          if (s[i] === '"') {
            i++;
            let str = '';
            while (i < s.length) {
              if (s[i] === '"') {
                if (s[i + 1] === '"') { str += '"'; i += 2; continue; }
                i++;
                break;
              }
              str += s[i++];
            }
            arg = { kind: 'string', value: str };
          } else {
            let raw = '';
            while (i < s.length && s[i] !== ',' && s[i] !== ']') raw += s[i++];
            raw = raw.trim();
            if (raw === '') throw new SyntaxError('empty arg');
            arg = { kind: 'token', value: raw };
          }
          args.push(arg);
          skipSpace();
          if (s[i] === ',') { i++; skipSpace(); continue; }
          if (s[i] === ']') { i++; break; }
          throw new SyntaxError("expected ',' or ']' in args");
        }
      }
      skipSpace();
    }
    options.push({ name, args });
    skipSpace();
  }
  if (s[i] !== ')') throw new SyntaxError("expected ')'");
  i++;
  skipSpace();
  if (i !== s.length) throw new SyntaxError('trailing content after )');
  return { cmd, id, options };
}

// -------------------------------------------------------------------------
// Reply formatter
// -------------------------------------------------------------------------
// Every reply has the shape
//   <REPLY <raw>>\n
//   <body lines, each ending in \n>
//   <END N (NAME)>\n
// `formatReply` accepts the original raw frame so the echo is byte-identical
// to the client's command (iTrain sends no whitespace, JMRI sends ', ' — both
// must round-trip exactly).

function formatReply(raw, body, err) {
  err = err || ERR.OK;
  const lines = [`<REPLY ${raw}>`];
  if (body && body.length) {
    for (const ln of body) lines.push(ln);
  }
  lines.push(`<END ${err.code} (${err.name})>`);
  return lines.join('\n') + '\n';
}

function formatEvent(objectId, body) {
  const lines = [`<EVENT ${objectId}>`];
  if (body && body.length) {
    for (const ln of body) lines.push(ln);
  }
  lines.push('<END 0 (OK)>');
  return lines.join('\n') + '\n';
}

// Render a JS value back to its on-the-wire form.
//   string  -> "..."  with embedded "  doubled
//   number  -> as-is
//   boolean -> 0 / 1
function fmtArg(v) {
  if (typeof v === 'string') {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

// -------------------------------------------------------------------------
// idClass: classify an id into its handler bucket.
// -------------------------------------------------------------------------
function idClass(id) {
  if (id === 1)  return 'ecos';
  if (id === 5)  return 'progGleis';
  if (id === 10) return 'lokmgr';
  if (id === 11) return 'swmgr';
  if (id === 12) return 'pendelmgr';
  if (id === 20) return 'devmgr';
  if (id === 25) return 'sniffer';
  if (id === 26) return 'fbmgr';
  if (id === 27) return 'booster';
  if (id === 31) return 'stellpult';
  if (id >= 100 && id <= 163) return 's88';
  if (id >= 200 && id <= 299) return 'ecosDetector';
  if (id >= 1000 && id < 20000) return 'lok';
  if (id >= 20000) return 'accessory';
  return null;
}

// -------------------------------------------------------------------------
// State helpers
// -------------------------------------------------------------------------
function defaultState() {
  return {
    status: 'GO',
    info: {
      ecos: 'ECoS',
      protocolVersion: '0.5',
      applicationVersion: '4.2.13',
      hardwareVersion: '2.1',
      id: 0,
    },
    loks: {
      1000: makeLok({
        id: 1000, addr: 3, name: 'Fake Locomotive 1000', protocol: 'DCC28',
      }),
    },
    accessories: {},
    s88Modules: {},
    ecosDetectors: {
      200: { id: 200, ports: 2, state: 0, railcom: {} },
    },
    views: {},
    controls: {},
    nextLokId: 1001,
    nextAccessoryId: 20001,
    layout: { accessories: {}, feedback: {}, loks: {} },
  };
}

function makeLok(opts) {
  return {
    id: opts.id,
    addr: opts.addr,
    name: opts.name,
    protocol: opts.protocol,
    speed: 0,
    speedstep: 0,
    dir: 0,
    funcs: {},
    funcdescs: {},
    cvs: {},
    favorit: 0,
    sniffer: 0,
    speedindicator: 0,
    profile: '',
    locodesc: { imagetype: 'IMAGE_TYPE_INT', imageindex: 0 },
    symbol: 0,
  };
}

function ensureView(state, objectId, sessionId) {
  if (!state.views[objectId]) state.views[objectId] = [];
  if (state.views[objectId].indexOf(sessionId) === -1) state.views[objectId].push(sessionId);
}

function dropView(state, objectId, sessionId) {
  const v = state.views[objectId];
  if (!v) return;
  const idx = v.indexOf(sessionId);
  if (idx !== -1) v.splice(idx, 1);
}

function viewersOf(state, objectId) {
  return (state.views[objectId] || []).slice();
}

// -------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------
// Each handler returns { body, err, sideEffects, events }. Caller wraps with
// formatReply.

function err(code, body) { return { body: body || [], err: code }; }
function ok(body) { return { body: body || [], err: ERR.OK }; }

function tokVal(arg) { return arg && arg.value; }

// ---- id=1 ECoS ----
function handleEcos(parsed, sessionId, state) {
  const { cmd, options } = parsed;
  if (cmd === 'request') {
    if (!options.length || options[0].name !== 'view') return err(ERR.BADPARAMETER);
    ensureView(state, 1, sessionId);
    return ok();
  }
  if (cmd === 'release') {
    if (!options.length || options[0].name !== 'view') return err(ERR.BADPARAMETER);
    dropView(state, 1, sessionId);
    return ok();
  }
  if (cmd === 'set') {
    if (!options.length) return err(ERR.NOPARAMETER);
    const op = options[0].name;
    if (op === 'go' || op === 'stop' || op === 'shutdown') {
      const next = op.toUpperCase();
      const transition = state.status !== next;
      state.status = next;
      const events = [];
      const viewers = viewersOf(state, 1);
      if (transition && viewers.length) {
        events.push({
          subscribers: viewers,
          payload: formatEvent(1, [`1 status[${next}]`]),
        });
      }
      return { body: [], err: ERR.OK, events };
    }
    return err(ERR.BADPARAMETER);
  }
  if (cmd === 'get') {
    if (!options.length) return err(ERR.NOPARAMETER);
    const body = [];
    let bad = false;
    for (const o of options) {
      if (o.name === 'info') {
        body.push(`1 ${state.info.ecos}`);
        body.push(`1 ProtocolVersion[${state.info.protocolVersion}]`);
        body.push(`1 ApplicationVersion[${state.info.applicationVersion}]`);
        body.push(`1 HardwareVersion[${state.info.hardwareVersion}]`);
      } else if (o.name === 'status') {
        body.push(`1 status[${state.status}]`);
      } else if (o.name === 'id') {
        body.push(`1 id[${state.info.id}]`);
      } else {
        bad = true; break;
      }
    }
    if (bad) return err(ERR.BADPARAMETER);
    return ok(body);
  }
  return err(ERR.BADPARAMETER);
}

// ---- id=10 LokManager ----
function handleLokMgr(parsed, sessionId, state) {
  const { cmd, options } = parsed;
  if (cmd === 'request') {
    if (!options.length || options[0].name !== 'view') return err(ERR.BADPARAMETER);
    ensureView(state, 10, sessionId);
    return ok();
  }
  if (cmd === 'release') {
    if (!options.length || options[0].name !== 'view') return err(ERR.BADPARAMETER);
    dropView(state, 10, sessionId);
    return ok();
  }
  if (cmd === 'get') {
    if (options.length && options[0].name === 'size') {
      return ok([`10 size[${Object.keys(state.loks).length}]`]);
    }
    return err(ERR.BADPARAMETER);
  }
  if (cmd === 'queryObjects') {
    return ok(queryLoks(state, options));
  }
  if (cmd === 'create') {
    return createLok(state, options);
  }
  return err(ERR.BADPARAMETER);
}

function lokInRange(lok, min, max) {
  return lok.id >= min && lok.id <= max;
}

function queryLoks(state, options) {
  let nrFilter = null;
  const fields = [];
  for (const o of options) {
    if (o.name === 'nr') {
      const a = o.args.map(tokVal).map(Number);
      if (a.length === 2 && Number.isFinite(a[0]) && Number.isFinite(a[1])) nrFilter = [a[0], a[1]];
    } else if (o.name === 'name' || o.name === 'addr' || o.name === 'protocol') {
      fields.push(o.name);
    }
  }
  const ids = Object.keys(state.loks).map(Number).sort((a, b) => a - b);
  const out = [];
  for (const id of ids) {
    const lok = state.loks[id];
    if (nrFilter && !lokInRange(lok, nrFilter[0], nrFilter[1])) continue;
    if (!fields.length) {
      out.push(`${lok.id}`);
    } else {
      const parts = [`${lok.id}`];
      for (const f of fields) {
        if (f === 'name') parts.push(`name[${fmtArg(lok.name)}]`);
        else if (f === 'addr') parts.push(`addr[${lok.addr}]`);
        else if (f === 'protocol') parts.push(`protocol[${lok.protocol}]`);
      }
      out.push(parts.join(' '));
    }
  }
  return out;
}

function createLok(state, options) {
  const append = options.some(o => o.name === 'append');
  const discard = options.some(o => o.name === 'discard');
  if (!append && !discard) return err(ERR.NOAPPEND);
  if (discard) return ok();
  const init = { id: state.nextLokId++, addr: 0, name: '', protocol: 'DCC28' };
  for (const o of options) {
    if (o.name === 'addr' && o.args.length) init.addr = Number(tokVal(o.args[0]));
    if (o.name === 'name' && o.args.length) init.name = String(tokVal(o.args[0]));
    if (o.name === 'protocol' && o.args.length) {
      const p = String(tokVal(o.args[0]));
      if (!VALID_PROTOCOLS.has(p)) return err(ERR.BADPARAMETER);
      init.protocol = p;
    }
  }
  const lok = makeLok(init);
  state.loks[lok.id] = lok;
  const body = [`${lok.id}`];
  return { body, err: ERR.OK, events: [{
    subscribers: viewersOf(state, 10),
    payload: formatEvent(10, ['10 msg[LIST_CHANGED]']),
  }] };
}

// ---- id=11 SchaltartikelManager ----
function handleSwMgr(parsed, sessionId, state) {
  const { cmd, options } = parsed;
  if (cmd === 'request') {
    const wantsView = options.some(o => o.name === 'view');
    if (!wantsView) return err(ERR.BADPARAMETER);
    ensureView(state, 11, sessionId);
    return ok();
  }
  if (cmd === 'release') {
    const wantsView = options.some(o => o.name === 'view');
    if (!wantsView) return err(ERR.BADPARAMETER);
    dropView(state, 11, sessionId);
    return ok();
  }
  if (cmd === 'get') {
    if (options.length && options[0].name === 'size') {
      return ok([`11 size[${Object.keys(state.accessories).length}]`]);
    }
    if (options.length && options[0].name === 'switch') {
      const a = options[0].args[0];
      if (!a) return err(ERR.NOPARAMETER);
      const parsed2 = parseSwitchArg(tokVal(a));
      if (!parsed2) return err(ERR.BADPARAMETER);
      const key = `${parsed2.protocol}${parsed2.addr}`;
      const acc = state.accessoriesByAddr ? state.accessoriesByAddr[key] : null;
      const wire = acc ? acc.wire : null;
      if (!wire) return err(ERR.NOOBJECT);
      return ok([`11 switch[${parsed2.protocol}${parsed2.addr}${wire}]`]);
    }
    return err(ERR.BADPARAMETER);
  }
  if (cmd === 'set') {
    if (options.length && options[0].name === 'switch') {
      const a = options[0].args[0];
      if (!a) return err(ERR.NOPARAMETER);
      const parsed2 = parseSwitchArg(tokVal(a));
      if (!parsed2) return err(ERR.BADPARAMETER);
      if (!state.accessoriesByAddr) state.accessoriesByAddr = {};
      const key = `${parsed2.protocol}${parsed2.addr}`;
      state.accessoriesByAddr[key] = { ...parsed2 };
      const events = [{
        subscribers: viewersOf(state, 11),
        payload: formatEvent(11, [`11 switch[${parsed2.protocol}${parsed2.addr}${parsed2.wire}]`]),
      }];
      const sideEffects = [{
        kind: 'switch',
        protocol: parsed2.protocol,
        addr: parsed2.addr,
        wire: parsed2.wire,
      }];
      return { body: [], err: ERR.OK, events, sideEffects };
    }
    return err(ERR.BADPARAMETER);
  }
  if (cmd === 'queryObjects') {
    const ids = Object.keys(state.accessories).map(Number).sort((a, b) => a - b);
    return ok(ids.map(id => `${id}`));
  }
  if (cmd === 'create') {
    const append = options.some(o => o.name === 'append');
    const discard = options.some(o => o.name === 'discard');
    if (!append && !discard) return err(ERR.NOAPPEND);
    if (discard) return ok();
    const id = state.nextAccessoryId++;
    state.accessories[id] = { id, addr: 0, addrext: 0, protocol: 'DCC',
      mode: 'SWITCH', duration: 250, name1: '', name2: '', name3: '',
      symbol: 0, state: 0 };
    return ok([`${id}`]);
  }
  return err(ERR.BADPARAMETER);
}

function parseSwitchArg(s) {
  if (!s) return null;
  const m = /^(MOT|DCC)(\d+)([rg])$/.exec(s);
  if (!m) return null;
  return { protocol: m[1], addr: parseInt(m[2], 10), wire: m[3] };
}

// ---- id=26 Feedback-Manager ----
function handleFbMgr(parsed, sessionId, state) {
  const { cmd, options } = parsed;
  if (cmd === 'request') {
    if (!options.length || options[0].name !== 'view') return err(ERR.BADPARAMETER);
    ensureView(state, 26, sessionId);
    return ok();
  }
  if (cmd === 'release') {
    if (!options.length || options[0].name !== 'view') return err(ERR.BADPARAMETER);
    dropView(state, 26, sessionId);
    return ok();
  }
  if (cmd === 'get') {
    if (options.length && options[0].name === 'size') {
      const n = Object.keys(state.s88Modules).length + Object.keys(state.ecosDetectors).length;
      return ok([`26 size[${n}]`]);
    }
    return err(ERR.BADPARAMETER);
  }
  if (cmd === 'queryObjects') {
    const wantPorts = options.some(o => o.name === 'ports');
    const out = [];
    const s88Ids = Object.keys(state.s88Modules).map(Number).sort((a, b) => a - b);
    for (const id of s88Ids) {
      const m = state.s88Modules[id];
      out.push(wantPorts ? `${id} ports[${m.ports}]` : `${id}`);
    }
    const detIds = Object.keys(state.ecosDetectors).map(Number).sort((a, b) => a - b);
    for (const id of detIds) {
      const d = state.ecosDetectors[id];
      out.push(wantPorts ? `${id} ports[${d.ports}]` : `${id}`);
    }
    return ok(out);
  }
  if (cmd === 'create') {
    const add = options.find(o => o.name === 'add');
    if (!add) return err(ERR.BADPARAMETER);
    const args = add.args.map(tokVal).map(Number);
    if (args.length < 2) return err(ERR.BADPARAMETER);
    const pos = args[0];
    const ports = args[1];
    const id = 100 + pos;
    if (id < 100 || id > 163) return err(ERR.BADPARAMETER);
    state.s88Modules[id] = { id, ports, state: 0 };
    return ok([`${id}`]);
  }
  if (cmd === 'delete') {
    const del = options.find(o => o.name === 'del');
    if (!del) return err(ERR.BADPARAMETER);
    const pos = Number(tokVal(del.args[0]));
    const id = 100 + pos;
    if (state.s88Modules[id]) delete state.s88Modules[id];
    return ok();
  }
  if (cmd === 'set') {
    if (options.length && options[0].name === 'size') {
      // accepted but no-op
      return ok();
    }
    return err(ERR.BADPARAMETER);
  }
  return err(ERR.BADPARAMETER);
}

// ---- id≥1000 Lok ----
function handleLok(parsed, sessionId, state) {
  const { cmd, id, options } = parsed;
  const lok = state.loks[id];
  if (!lok) {
    // delete on a missing lok still NOOBJECT.
    return err(ERR.NOOBJECT);
  }
  if (cmd === 'request') {
    const wantsView = options.some(o => o.name === 'view');
    const wantsControl = options.some(o => o.name === 'control');
    const force = options.some(o => o.name === 'force');
    if (wantsView) ensureView(state, id, sessionId);
    if (wantsControl) {
      const cur = state.controls[id];
      if (cur && cur !== sessionId && !force) return err(ERR.NOCONTROL);
      state.controls[id] = sessionId;
    }
    if (!wantsView && !wantsControl) return err(ERR.BADPARAMETER);
    return ok();
  }
  if (cmd === 'release') {
    const wantsView = options.some(o => o.name === 'view');
    const wantsControl = options.some(o => o.name === 'control');
    if (wantsView) dropView(state, id, sessionId);
    if (wantsControl && state.controls[id] === sessionId) state.controls[id] = null;
    if (!wantsView && !wantsControl) return err(ERR.BADPARAMETER);
    return ok();
  }
  if (cmd === 'get') return getLokFields(lok, id, options);
  if (cmd === 'set') return setLokFields(state, lok, id, sessionId, options);
  if (cmd === 'delete') {
    delete state.loks[id];
    return { body: [], err: ERR.OK, events: [{
      subscribers: viewersOf(state, 10),
      payload: formatEvent(10, ['10 msg[LIST_CHANGED]']),
    }] };
  }
  if (cmd === 'link' || cmd === 'unlink') {
    return ok();
  }
  if (cmd === 'queryObjects') {
    return ok([]);
  }
  return err(ERR.BADPARAMETER);
}

function getLokFields(lok, id, options) {
  if (!options.length) return ok();
  const body = [];
  for (const o of options) {
    const v = readLokField(lok, o);
    if (v == null) return err(ERR.BADPARAMETER);
    body.push(`${id} ${v}`);
  }
  return ok(body);
}

function readLokField(lok, o) {
  switch (o.name) {
    case 'addr':           return `addr[${lok.addr}]`;
    case 'name':           return `name[${fmtArg(lok.name)}]`;
    case 'protocol':       return `protocol[${lok.protocol}]`;
    case 'speed':          return `speed[${lok.speed}]`;
    case 'speedstep':      return `speedstep[${lok.speedstep}]`;
    case 'dir':            return `dir[${lok.dir}]`;
    case 'favorit':        return `favorit[${lok.favorit}]`;
    case 'sniffer':        return `sniffer[${lok.sniffer}]`;
    case 'speedindicator': return `speedindicator[${lok.speedindicator}]`;
    case 'profile':        return `profile[${fmtArg(lok.profile)}]`;
    case 'symbol':
    case 'funcsymbol': {
      const idx = o.args.length ? Number(tokVal(o.args[0])) : 0;
      const v = lok.funcs[idx] || 0;
      return `func[${idx}, ${v}]`;
    }
    case 'func': {
      if (!o.args.length) return null;
      const idx = Number(tokVal(o.args[0]));
      if (!Number.isFinite(idx)) return null;
      const v = lok.funcs[idx] || 0;
      return `func[${idx}, ${v}]`;
    }
    case 'funcdesc': {
      if (!o.args.length) return null;
      const idx = Number(tokVal(o.args[0]));
      const d = lok.funcdescs[idx];
      if (!d) return `funcdesc[${idx}, 0]`;
      return `funcdesc[${idx}, ${d.code}${d.moment ? ', moment' : ''}]`;
    }
    case 'funcexists': {
      if (!o.args.length) return null;
      const idx = Number(tokVal(o.args[0]));
      const exists = (lok.funcs[idx] !== undefined) || (lok.funcdescs[idx] !== undefined);
      return `funcexists[${idx}, ${exists ? 1 : 0}]`;
    }
    case 'cv': {
      if (o.args.length !== 1) return null;
      const nr = Number(tokVal(o.args[0]));
      const v = lok.cvs[nr];
      if (v == null) return null;
      return `cv[${nr}, ${v}]`;
    }
    case 'locodesc': {
      const ld = lok.locodesc;
      return `locodesc[${ld.imagetype}, ${ld.imageindex}]`;
    }
    default: return null;
  }
}

function setLokFields(state, lok, id, sessionId, options) {
  // Spec §5: set without control normally fails; iTrain skips request(control).
  // Be lenient: only enforce control when a control owner is set and it's not us.
  const owner = state.controls[id];
  if (owner && owner !== sessionId) return err(ERR.NOCONTROL);
  const sideEffects = [];
  let speedTouched = false;
  let dirTouched = false;
  let funcTouched = null; // index that changed
  for (const o of options) {
    if (o.name === 'stop') {
      lok.speed = 0; lok.speedstep = 0;
      speedTouched = true;
    } else if (o.name === 'speed' || o.name === 'speedstep') {
      if (!o.args.length) return err(ERR.NOPARAMETER);
      const v = Number(tokVal(o.args[0]));
      if (!Number.isFinite(v)) return err(ERR.BADPARAMETER);
      lok[o.name] = v;
      speedTouched = true;
    } else if (o.name === 'dir') {
      if (!o.args.length) return err(ERR.NOPARAMETER);
      const v = Number(tokVal(o.args[0]));
      if (v !== 0 && v !== 1) return err(ERR.BADPARAMETER);
      lok.dir = v;
      dirTouched = true;
    } else if (o.name === 'addr') {
      if (!o.args.length) return err(ERR.NOPARAMETER);
      lok.addr = Number(tokVal(o.args[0]));
    } else if (o.name === 'name') {
      if (!o.args.length) return err(ERR.NOPARAMETER);
      lok.name = String(tokVal(o.args[0]));
    } else if (o.name === 'protocol') {
      if (!o.args.length) return err(ERR.NOPARAMETER);
      const p = String(tokVal(o.args[0]));
      if (!VALID_PROTOCOLS.has(p)) return err(ERR.BADPARAMETER);
      lok.protocol = p;
    } else if (o.name === 'func') {
      if (o.args.length < 2) return err(ERR.NOPARAMETER);
      const idx = Number(tokVal(o.args[0]));
      const v = Number(tokVal(o.args[1]));
      if (!Number.isFinite(idx)) return err(ERR.BADPARAMETER);
      lok.funcs[idx] = v;
      funcTouched = idx;
    } else if (o.name === 'funcdesc') {
      if (o.args.length < 2) return err(ERR.NOPARAMETER);
      const idx = Number(tokVal(o.args[0]));
      const code = Number(tokVal(o.args[1]));
      const moment = o.args.length >= 3 && tokVal(o.args[2]) === 'moment';
      lok.funcdescs[idx] = { code, moment };
    } else if (o.name === 'cv') {
      if (o.args.length < 2) return err(ERR.NOPARAMETER);
      const nr = Number(tokVal(o.args[0]));
      const v = Number(tokVal(o.args[1]));
      lok.cvs[nr] = v;
    } else if (o.name === 'favorit' || o.name === 'sniffer' || o.name === 'speedindicator') {
      if (!o.args.length) return err(ERR.NOPARAMETER);
      lok[o.name] = Number(tokVal(o.args[0]));
    } else if (o.name === 'profile') {
      if (!o.args.length) return err(ERR.NOPARAMETER);
      lok.profile = String(tokVal(o.args[0]));
    } else if (o.name === 'symbol' || o.name === 'funcsymbol') {
      // legacy aliases - swallow without error
    } else {
      return err(ERR.BADPARAMETER);
    }
  }
  // MQTT side-effect for speed/dir mutations on our motor wire.
  if (speedTouched || dirTouched) {
    sideEffects.push({
      kind: 'lokSpeed',
      lokId: id,
      addr: lok.addr,
      speed: lok.speedstep || lok.speed || 0,
      dir: lok.dir,
    });
  }
  const events = [];
  const viewers = viewersOf(state, id);
  if (viewers.length) {
    const lines = [];
    if (speedTouched) lines.push(`${id} speedstep[${lok.speedstep}]`);
    if (dirTouched) lines.push(`${id} dir[${lok.dir}]`);
    if (funcTouched !== null) lines.push(`${id} func[${funcTouched}, ${lok.funcs[funcTouched]}]`);
    if (lines.length) {
      events.push({ subscribers: viewers, payload: formatEvent(id, lines) });
    }
  }
  return { body: [], err: ERR.OK, sideEffects, events };
}

// ---- id≥20000 Schaltartikel object form (JMRI) ----
function handleAccessory(parsed, sessionId, state) {
  const { cmd, id, options } = parsed;
  const acc = state.accessories[id];
  if (!acc) return err(ERR.NOOBJECT);
  if (cmd === 'request' || cmd === 'release') {
    const wantsView = options.some(o => o.name === 'view');
    const wantsControl = options.some(o => o.name === 'control');
    if (wantsView) (cmd === 'request' ? ensureView : dropView)(state, id, sessionId);
    if (wantsControl) {
      if (cmd === 'request') state.controls[id] = sessionId;
      else if (state.controls[id] === sessionId) state.controls[id] = null;
    }
    if (!wantsView && !wantsControl) return err(ERR.BADPARAMETER);
    return ok();
  }
  if (cmd === 'get') {
    if (!options.length) return err(ERR.NOPARAMETER);
    const body = [];
    for (const o of options) {
      switch (o.name) {
        case 'state':    body.push(`${id} state[${acc.state}]`); break;
        case 'addr':     body.push(`${id} addr[${acc.addr}]`); break;
        case 'addrext':  body.push(`${id} addrext[${acc.addrext}]`); break;
        case 'protocol': body.push(`${id} protocol[${acc.protocol}]`); break;
        case 'name1':    body.push(`${id} name1[${fmtArg(acc.name1)}]`); break;
        case 'name2':    body.push(`${id} name2[${fmtArg(acc.name2)}]`); break;
        case 'name3':    body.push(`${id} name3[${fmtArg(acc.name3)}]`); break;
        case 'symbol':   body.push(`${id} symbol[${acc.symbol}]`); break;
        case 'mode':     body.push(`${id} mode[${acc.mode}]`); break;
        case 'duration': body.push(`${id} duration[${acc.duration}]`); break;
        default: return err(ERR.BADPARAMETER);
      }
    }
    return ok(body);
  }
  if (cmd === 'set') {
    for (const o of options) {
      switch (o.name) {
        case 'state':    acc.state    = Number(tokVal(o.args[0])); break;
        case 'addr':     acc.addr     = Number(tokVal(o.args[0])); break;
        case 'addrext':  acc.addrext  = Number(tokVal(o.args[0])); break;
        case 'protocol': acc.protocol = String(tokVal(o.args[0])); break;
        case 'name1':    acc.name1    = String(tokVal(o.args[0])); break;
        case 'name2':    acc.name2    = String(tokVal(o.args[0])); break;
        case 'name3':    acc.name3    = String(tokVal(o.args[0])); break;
        case 'symbol':   acc.symbol   = Number(tokVal(o.args[0])); break;
        case 'mode':     acc.mode     = String(tokVal(o.args[0])); break;
        case 'duration': acc.duration = Number(tokVal(o.args[0])); break;
        default: return err(ERR.BADPARAMETER);
      }
    }
    return ok();
  }
  if (cmd === 'delete') {
    delete state.accessories[id];
    return ok();
  }
  if (cmd === 'link' || cmd === 'unlink') return ok();
  if (cmd === 'queryObjects') return ok([]);
  return err(ERR.BADPARAMETER);
}

// ---- s88 (id 100..163) and ECoSDetector (id 200+) ----
function handleS88(parsed, sessionId, state) {
  return handleFeedbackModule(parsed, sessionId, state, 's88');
}
function handleEcosDetector(parsed, sessionId, state) {
  return handleFeedbackModule(parsed, sessionId, state, 'ecosDetector');
}

function handleFeedbackModule(parsed, sessionId, state, kind) {
  const { cmd, id, options } = parsed;
  const bag = kind === 's88' ? state.s88Modules : state.ecosDetectors;
  let mod = bag[id];
  if (cmd === 'request' || cmd === 'release') {
    if (!options.length || options[0].name !== 'view') return err(ERR.BADPARAMETER);
    if (!mod) return err(ERR.NOOBJECT);
    (cmd === 'request' ? ensureView : dropView)(state, id, sessionId);
    return ok();
  }
  if (!mod) return err(ERR.NOOBJECT);
  if (cmd === 'get') {
    if (!options.length) return err(ERR.NOPARAMETER);
    const body = [];
    for (const o of options) {
      if (o.name === 'state') {
        const hex = '0x' + mod.state.toString(16);
        body.push(`${id} state[${hex}]`);
      } else if (o.name === 'ports') {
        body.push(`${id} ports[${mod.ports}]`);
      } else if (o.name === 'railcom') {
        const port = o.args.length ? Number(tokVal(o.args[0])) : 0;
        const rc = (mod.railcom || {})[port] || { addr: 0, dir: 0 };
        const portStr = String(port).padStart(2, '0');
        const addrStr = String(rc.addr).padStart(4, '0');
        body.push(`${id} railcom[${portStr}, ${addrStr}, ${rc.dir}]`);
      } else {
        return err(ERR.BADPARAMETER);
      }
    }
    return ok(body);
  }
  if (cmd === 'set') {
    for (const o of options) {
      if (o.name === 'ports' && o.args.length) mod.ports = Number(tokVal(o.args[0]));
      else if (o.name === 'state' && o.args.length) {
        const v = String(tokVal(o.args[0]));
        mod.state = v.startsWith('0x') ? parseInt(v.slice(2), 16) : parseInt(v, 10);
      } else {
        return err(ERR.BADPARAMETER);
      }
    }
    return ok();
  }
  if (cmd === 'delete') {
    if (kind !== 's88') return err(ERR.BADPARAMETER);
    delete state.s88Modules[id];
    return ok();
  }
  return err(ERR.BADPARAMETER);
}

// ---- Stub handlers for in-Planung sections ----
function handleStub(parsed, sessionId, state) {
  const { cmd } = parsed;
  if (cmd === 'request' || cmd === 'release' || cmd === 'set' ||
      cmd === 'get' || cmd === 'queryObjects' || cmd === 'create' ||
      cmd === 'delete' || cmd === 'link' || cmd === 'unlink') {
    return ok();
  }
  return err(ERR.BADPARAMETER);
}

// ---- Top-level dispatch ----
const DISPATCH = {
  ecos:         handleEcos,
  lokmgr:       handleLokMgr,
  swmgr:        handleSwMgr,
  fbmgr:        handleFbMgr,
  lok:          handleLok,
  accessory:    handleAccessory,
  s88:          handleS88,
  ecosDetector: handleEcosDetector,
  progGleis:    handleStub,
  pendelmgr:    handleStub,
  devmgr:       handleStub,
  sniffer:      handleStub,
  booster:      handleStub,
  stellpult:    handleStub,
};

// `handle` is the public entry point. `raw` is one complete frame (no
// trailing newline). `sessionId` is `msg._session.id`. `state` is the live
// `flow.facos` object — handlers mutate it in place.
function handle(raw, sessionId, state) {
  const cleaned = String(raw).replace(/[\r\n]+$/, '').trim();
  if (!cleaned) return null;
  let parsed;
  try {
    parsed = tokenize(cleaned);
  } catch (e) {
    return {
      raw: cleaned,
      parsed: null,
      reply: formatReply(cleaned, [], ERR.BADPARAMETER),
      sideEffects: [],
      events: [],
    };
  }
  const klass = idClass(parsed.id);
  if (!klass) {
    return {
      raw: cleaned,
      parsed,
      reply: formatReply(cleaned, [], ERR.NOOBJECT),
      sideEffects: [],
      events: [],
    };
  }
  const fn = DISPATCH[klass];
  let result;
  try {
    result = fn(parsed, sessionId, state);
  } catch (e) {
    return {
      raw: cleaned,
      parsed,
      reply: formatReply(cleaned, [], ERR.BADPARAMETER),
      sideEffects: [],
      events: [],
      error: e.message,
    };
  }
  return {
    raw: cleaned,
    parsed,
    reply: formatReply(cleaned, result.body || [], result.err || ERR.OK),
    sideEffects: result.sideEffects || [],
    events: result.events || [],
  };
}

// -- TCP framer (per-session line buffer) --
//
// `feedFrame` accepts a chunk arriving on tcp in for a session and returns an
// array of complete frames (no newline). It mutates `bufBag[sessionId]` for
// stateful accumulation.
function feedFrame(bufBag, sessionId, chunk) {
  const prev = bufBag[sessionId] || '';
  const combined = prev + String(chunk);
  const parts = combined.split('\n');
  const tail = parts.pop();
  bufBag[sessionId] = tail;
  return parts.map(p => p.replace(/\r+$/, ''));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tokenize,
    formatReply,
    formatEvent,
    fmtArg,
    idClass,
    defaultState,
    makeLok,
    handle,
    feedFrame,
    parseSwitchArg,
    ERR,
    VALID_PROTOCOLS,
  };
}

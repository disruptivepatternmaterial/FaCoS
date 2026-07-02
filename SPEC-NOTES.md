# SPEC-NOTES.md

Maps the ESU PC-Interface spec (Netzwerkspezifikation_fuer_PC-Interface,
v0.2 / §7) and the JMRI / Rocrail superset to handler functions in
`parser.js`. Use this when adding a handler or auditing coverage.

Conventions:
- `J` after a section means "JMRI emits this on the wire even though the spec
  marks it 'in Planung'" — those are implemented.
- `R` after a section means "Rocrail's emulator publishes this" — also
  implemented.
- "stub" means handler returns `<END 0 (OK)>` with empty body.

## Top-level (parser.js)

| Spec § | Topic | Handler |
| ------ | ----- | ------- |
| §3     | Frame format `<REPLY ...>` ... `<END N (NAME)>` | `formatReply()` |
| §3     | Event frame `<EVENT id>` ... `<END 0 (OK)>` | `formatEvent()` |
| §4     | Per-line UTF-8, `\n`-terminated, server tolerates `\r\n` | `feedFrame()` |
| §5     | Strings are `"..."`, embed `"` as `""` | `tokenize()` quoted-string state |
| §5     | Error codes 0/15/19/20/25/27/35 | `ERR` table; returned by handlers |

## Per-section coverage

### §7.1 — id=1, ECoS

| Command | Handler | Notes |
| ------- | ------- | ----- |
| `request(1, view)` | `handleEcos` request branch | per-session view set |
| `release(1, view)` | `handleEcos` release branch | |
| `set(1, go)` / `set(1, stop)` / `set(1, shutdown)` | `handleEcos` set branch | emits `<EVENT 1> 1 status[GO\|STOP\|SHUTDOWN]` only on transition AND only if there are viewers |
| `get(1, info)` | `handleEcos` get branch (`info` opt) | echoes ECoS / ProtocolVersion / ApplicationVersion / HardwareVersion lines |
| `get(1, status)` | `handleEcos` get branch (`status`) | |
| `get(1, id)` | `handleEcos` get branch (`id`) | J |

### §7.2 — id=5, Programmiergleis (in Planung)

`handleStub` — request/release/get/set return `<END 0 (OK)>`.

### §7.3 — id=10, LokManager

| Command | Handler | Notes |
| ------- | ------- | ----- |
| `request(10, view)` / `release(10, view)` | `handleLokMgr` | |
| `queryObjects(10)` | `handleLokMgr` queryObjects branch | one line per id |
| `queryObjects(10, name)` / `addr` / `protocol` | `queryLoks()` | each non-`nr` option is a field include |
| `queryObjects(10, name, addr)` etc. | `queryLoks()` | multiple fields combined on each line |
| `queryObjects(10, nr[min, max])` | `queryLoks()` `nrFilter` | filters lok ids |
| `get(10, size)` | `handleLokMgr` get branch | returns `10 size[N]` |
| `create(10, append, addr[..], name[".."], protocol[..])` | `createLok()` | returns new id, emits `<EVENT 10> 10 msg[LIST_CHANGED]` |
| `create(10, discard)` | `createLok()` | OK with no body |

### §7.4 — id=11, SchaltartikelManager

| Command | Handler | Notes |
| ------- | ------- | ----- |
| `request(11, view, viewswitch)` | `handleSwMgr` | `viewswitch` is a JMRI-style additional flag |
| `release(11, view)` | `handleSwMgr` | |
| `queryObjects(11)` | `handleSwMgr` queryObjects | iterates state.accessories (object form, id ≥ 20000) |
| `get(11, size)` | `handleSwMgr` get branch | |
| `set(11, switch[<MOT\|DCC><addr><r\|g>])` | `handleSwMgr` set branch | parsed by `parseSwitchArg`; produces `kind: switch` side-effect (routed to MQTT keepers); emits `<EVENT 11> 11 switch[..]` |
| `get(11, switch[<...>])` | `handleSwMgr` get branch | reads from `state.accessoriesByAddr` populated by previous set; returns `<END 19>` if never set (no fabrication) |
| `create(11, append\|discard, ...)` | `handleSwMgr` create branch | append returns new object id |

### §7.5 — id=12, Pendelzugsteuerung (in Planung)

`handleStub` — empty OK on all verbs.

### §7.6 — id=20, Devicemanager (in Planung)

`handleStub` — empty OK on all verbs.

### §7.7 — id=25, Sniffer

`handleStub` — request/release accepted, no events.

### §7.8 — id=26, Feedback-Manager

| Command | Handler | Notes |
| ------- | ------- | ----- |
| `request(26, view)` / `release` | `handleFbMgr` | |
| `queryObjects(26)` | `handleFbMgr` queryObjects | lists s88 ids and ECoSDetector ids in id order |
| `queryObjects(26, ports)` | `handleFbMgr` queryObjects (`wantPorts`) | adds `ports[N]` to each row (replaces the production `*CHANGEME*` hardcode) |
| `get(26, size)` | `handleFbMgr` get branch | |
| `create(26, add[pos, ports])` | `handleFbMgr` create branch | id = 100 + pos, range-checked 100..163 |
| `delete(26, del[pos])` | `handleFbMgr` delete branch | |
| `set(26, size[..])` | `handleFbMgr` set branch | accepted no-op (legacy compatibility) |

### §7.9 — id=27, Booster (in Planung)

`handleStub` — empty OK.

### §7.10 — id=31, Stellpult (in Planung)

`handleStub` — empty OK.

### §7.11 — Lok object (id ≥ 1000)

| Command | Handler | Notes |
| ------- | ------- | ----- |
| `request(<id>, view)` / `release(..., view)` | `handleLok` | |
| `request(<id>, control[, force])` / `release(..., control)` | `handleLok` | force overrides existing owner; otherwise NOCONTROL |
| `get(<id>, addr\|name\|protocol\|speed\|speedstep\|dir\|favorit\|sniffer\|speedindicator\|profile)` | `readLokField()` | |
| `get(<id>, func[n])` | `readLokField()` | unset func returns `func[n, 0]` (legacy default) |
| `get(<id>, funcdesc[n])` | `readLokField()` | unset returns `funcdesc[n, 0]` |
| `get(<id>, funcexists[n])` | `readLokField()` | |
| `get(<id>, cv[n])` | `readLokField()` | unset cv returns `<END 15>` (no fabrication) |
| `get(<id>, locodesc)` | `readLokField()` | |
| `get(<id>, symbol)` / `funcsymbol[n]` | `readLokField()` | legacy aliases iTrain emits |
| `set(<id>, speed\|speedstep\|dir\|stop)` | `setLokFields` | emits `lokSpeed` side-effect (MQTT) and `<EVENT id>` to viewers |
| `set(<id>, func[n, val])` | `setLokFields` | emits `<EVENT id> func[n, val]` |
| `set(<id>, funcdesc[n, code, moment?])` | `setLokFields` | |
| `set(<id>, cv[n, val])` | `setLokFields` | |
| `set(<id>, addr\|name\|protocol\|profile\|favorit\|sniffer\|speedindicator)` | `setLokFields` | protocol validated against `VALID_PROTOCOLS` |
| `link(<id>, ...)` / `unlink(<id>, ...)` | `handleLok` link/unlink | OK no body |
| `delete(<id>)` | `handleLok` delete branch | emits `LIST_CHANGED` |
| `queryObjects(<id>)` | `handleLok` queryObjects branch | empty body |

Valid protocols: MM14, MM27, MM28, DCC14, DCC28, DCC128, SX32, MMFKT.

### §7.11.x — Schaltartikel object (id ≥ 20000)

Spec marks these "in Planung" but JMRI emits them. `handleAccessory` covers
request/release view+control, get/set state/addr/addrext/protocol/name1/2/3/
symbol/mode/duration, link/unlink, delete, queryObjects.

### §7.12 — Feedback module (id 100..163 = s88, id 200..299 = ECoSDetector)

Both share `handleFeedbackModule()`.

| Command | Handler | Notes |
| ------- | ------- | ----- |
| `request(<id>, view)` / `release(..., view)` | shared | |
| `get(<id>, state)` | shared | returns hex `0xN` |
| `get(<id>, ports)` | shared | |
| `get(<id>, railcom[port])` | shared | port zero-padded to 2 digits, addr to 4 digits, dir as int — matches the production wire format |
| `set(<id>, ports[..])` / `set(<id>, state[..])` | shared | |
| `delete(<id>)` | shared | s88 only |

### Pendelzugstrecke (in Planung)

`handleStub`.

## Side-effect routing

The parser emits side-effect descriptors on Output 1. The `side-effects
dispatch` function-node splits them into:

- `kind: switch` -> `switch -> raw` shim -> `4e2cc9eb2ddadad8` (verbatim
  keeper) -> `7485938bd6ccdaec` (verbatim keeper) -> MQTT `trains/device/`
- `kind: lokSpeed` -> `lokSpeed -> raw` shim -> `24dc6b2d70f47d9e` (verbatim
  keeper) -> `4721cdc23d5f9473` (verbatim keeper) -> MQTT `trains/device/`

The HA-side keepers (`f235fbbc2f3535a6`, `b13bfa380f4582a8`,
`3843a287d6cf613b`, `1bf2aa2b2ca64b87`) and the binary-sensor bridge
(`8759c8a437d1bfc1`, `cfd7460388fc6861`, `b922981349a7ceb7`) are unchanged
and continue to drive `<EVENT 200>` exactly as before; the new event-link
node receives those events and fans them out to viewers of id=200.

## Verification commands

Per `no-aspirational-docs.mdc`:

```
# Layer 1, 2, 4, 5 (no docker required)
bash tests/run-tests.sh

# Layer 5 only (re-verify sidewires after a parser.js edit)
bash tests/diff-sidewires.sh

# Layer 3 (docker + mosquitto, runs Node-RED in container)
bash tests/sideeffects.sh
```

If a claim in this file diverges from the test output, the test wins. Update
this file or the parser, never the other way around.

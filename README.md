# FaCoS

Fake ESU ECoS PC-Interface server, implemented as a single Node-RED tab. Lets
iTrain or JMRI talk to a Node-RED-based layout (HA / MQTT / hardware) as if it
were an ECoS command station.

This is a paste-ready Node-RED flow. Import `flow.json` onto whichever
Node-RED instance owns your layout (today: BowmanMtn; future: Trail Controller
Mac), point your throttle at `tcp://<host>:15471`, and the parser handles the
rest.

> 🚧 NOT YET DEPLOYED — `flow.json` (the full-emulator rewrite produced by
> `tools/build-flow.js`) has not been imported on any Node-RED host yet.
> Production at `BowmanMtn:~/docker/node-red/projects/bowman-mtn-node-red/flows.json`
> is still running the **old** FaCoS subset (113 nodes on the FaCoS tab,
> 34-rule main dispatcher switch `199f8c9cd04f45a5`).
>
> **Coming back to this project? Read [`HANDOFF.md`](HANDOFF.md) first** for
> current state, the migration-to-Trail-Controller checklist, known
> coverage gaps to watch for in the trace log, and the resumption
> checklist. This README is "how to use the deliverable"; HANDOFF is
> "where we left off".

## What's verified to work

Per `no-aspirational-docs.mdc`: this section only describes behavior the test
suite proves.

| Layer | Test | What it covers |
| ----- | ---- | -------------- |
| 1     | `node tests/parser-unit.js`     | Tokenizer (quoted strings, escaped quotes, embedded commas/brackets, empty arg detection). Per-section handlers for id=1, id=10, id=11, id=26, id=200, dynamic loks. All 8 valid protocols. CV roundtrip. Control acquisition + force takeover. Per-session view fan-out. Framer line-buffer (multi-frame split, partial frame, CR stripping). |
| 2     | `node tests/run-session.js`     | 37-line scripted session sourced from §7 of the ESU spec, byte-diffed against `tests/expected-replies.txt`. |
| 4     | `node tests/multi-session.js`   | Two parallel sessions: events fan out only to viewers; control is per-session and force takeover works. |
| 5     | `bash tests/diff-sidewires.sh`  | The 14 sidewire keepers (function bodies, change rules) are byte-identical to the production export at `/Volumes/home-BowmanMtn/docker/node-red/projects/bowman-mtn-node-red/flows.json`. |

Run the whole local suite (no docker needed):

```
bash tests/run-tests.sh
```

Layer 3 (MQTT + HA wire-payload assertions) needs docker + mosquitto-clients
and is run separately:

```
bash tests/sideeffects.sh
```

Layer 6 (live capture under iTrain / JMRI) is a manual step: enable the trace
toggle in the flow and share `cursor-scratch/facos-trace.log`.

## Coverage matrix

This is what the parser implements. Anything marked "stub" returns
`<END 0 (OK)>` with an empty body so probing clients don't choke.

| ID range | Section | Status |
| -------- | ------- | ------ |
| 1        | ECoS                    | full: request/release view, get info/status/id, set go/stop/shutdown; emits `<EVENT 1>` on transition |
| 5        | Programmiergleis        | stub (in Planung) |
| 10       | LokManager              | request/release view, queryObjects (name/addr/protocol/nr filters), get size, create with append/discard, emits `LIST_CHANGED` |
| 11       | SchaltartikelManager    | request/release view+viewswitch, queryObjects, get size, set/get switch[\<MOT\|DCC\>\<addr\>\<r\|g\>], create with append/discard; emits `<EVENT 11> switch[..]` |
| 12       | Pendelzugsteuerung      | stub (in Planung) |
| 20       | Devicemanager           | stub (in Planung) |
| 25       | Sniffer                 | stub |
| 26       | Feedback-Manager        | request/release, queryObjects (incl. ports), get size, create add[pos,ports], delete del[pos], set size |
| 27       | Booster                 | stub (in Planung) |
| 31       | Stellpult               | stub (in Planung) |
| 100..163 | s88                     | request/release view, get/set state, ports, delete |
| 200..299 | ECoSDetector            | request/release view, get state (hex), get railcom[port] (port,addr,dir) |
| 1000+    | Lok                     | request/release view+control[+force], get/set addr/name/protocol/speed/speedstep/dir/func[n]/funcdesc[n]/cv[n]/favorit/sniffer/speedindicator/profile, set stop, link/unlink, delete; emits `<EVENT id>` on speed/dir/func mutations |
| 20000+   | Schaltartikel object    | request/release view+control, get/set state/addr/addrext/protocol/name1/2/3/symbol/mode/duration, link/unlink/delete |

Error codes returned per ESU spec §5 + JMRI's NetworkErrorCodes table:
`0 (OK)`, `15 (NERROR_BADPARAMETER)`, `19 (NERROR_NOOBJECT)`,
`20 (NERROR_NOPARAMETER)`, `25 (NERROR_NOCONTROL)`,
`27 (NERROR_NOAPPEND)`, `35 (NERROR_NOAPPEND)`.

See `SPEC-NOTES.md` for §-by-§ mapping into the parser source.

## Architecture

```
tcp in :15471
  -> framer (per-session line buffer, flow.facosBuf)
    -> parser/dispatcher/formatter (single function node, source = parser.js)
      Output 0: replies   -> tcp out (reply mode)
      Output 1: side-fx   -> dispatch to existing change/MQTT keepers
      Output 2: events    -> fan-out per viewer -> tcp out
      Output 3: trace     -> trace gate -> file out (cursor-scratch/facos-trace.log)
      Output 4: unhandled -> debug node
```

The parser source lives in `parser.js` and is the single source of truth.
`tools/build-flow.js` inlines it into the function-node body of `flow.json`,
preserving the 14 sidewire keepers from the production export verbatim.

To rebuild `flow.json` after editing `parser.js` or any of the keepers:

```
node tools/build-flow.js
bash tests/run-tests.sh
```

## Importing on a fresh Node-RED

The tab id is `ae42528ac326c82b` (FaCoS), the MQTT broker config-node is
`4e91dd5ffb6a9ee8`, the HA server config-node is `85b918fc1d4c8834`. If your
Node-RED already has those configured (BowmanMtn does), the import swaps in
cleanly.

Procedure:

1. In Node-RED's hamburger menu: Import > paste contents of `flow.json`.
2. If you don't have config nodes with those exact ids, the import dialog
   will warn; create matching mqtt-broker / Home Assistant server configs and
   either keep the same ids or remap.
3. Deploy.

## Per-session view fan-out (real bug fixed)

The old flow used a global `tcp out` in `reply` mode for events too. With one
client that worked; with two clients (iTrain plus JMRI throttle) the events
went to whichever client most recently sent a frame. The new parser tracks
viewers in `flow.facos.views[objectId]` and clones each event message
per-subscriber, with `msg._session.id` set correctly. Layer 4 test asserts
this.

## Trace logger

Off by default. Click the `toggle trace log` inject node to flip on. Each
incoming frame writes a line to `cursor-scratch/facos-trace.log` (or whatever
`connection.json` says):

```
2026-05-17T15:00:00.000Z   <sessionId>   "set(1000,speedstep[14],dir[1])"   set:1000
```

When iTrain / JMRI sends a command we don't handle, the `unhandled` debug
node also catches it. Send the trace log + a screenshot of `unhandled` and
the next handler can be wired up.

## Adding a new lok or accessory at runtime

Either drive `create(10, append, addr[N], name["..."], protocol[DCC28])` from
the throttle, or pre-seed via `layout-map.json`:

```json
{
  "loks": {
    "1001": { "addr": 5, "name": "Big Boy", "protocol": "DCC28" }
  }
}
```

`layout-map.json` is loaded once at flow start by the `load layout-map`
inject chain and overlaid onto `flow.facos.layout`.

## `layout-map.json` schema

| key                                           | meaning |
| ---------                                     | ------- |
| `accessories.<addr>.ha_entity`                | HA entity id for this protocol address |
| `accessories.<addr>.on` / `.off`              | wire char (`g`/`r`) that maps to HA on/off |
| `feedback.<id>.ports`                         | port count for an ECoSDetector / s88 |
| `feedback.<id>.port_sensors`                  | array of HA `binary_sensor.*` driving each port |
| `loks.<id>.addr` / `.name` / `.protocol`      | seed values for `flow.facos.loks[id]` |

## `connection.json` schema

| key                  | meaning |
| -------              | ------- |
| `tcp_port`           | TCP port for the iTrain/JMRI throttle (default 15471) |
| `mqtt_topic_prefix`  | MQTT topic prefix for accessory / lok side-effects (default `trains/device/`) |
| `trace_log_path`     | Where the trace logger writes (default `cursor-scratch/facos-trace.log`) |

## Move-to-Trail-Controller-Mac checklist

The flow uses three host-coupled pieces. All three are isolated:

1. **MQTT broker**: config-node `4e91dd5ffb6a9ee8`. On Trail Controller Mac,
   either point this config at the Mac's MQTT broker or keep it pointing at
   `mqtt.tableman.com`.
2. **HA server**: config-node `85b918fc1d4c8834`. Same procedure.
3. **Layout map**: `layout-map.json`. Edit it to match the Mac's layout.

No node-graph surgery needed; just import the flow, set the two config
nodes, and swap `layout-map.json`.

## Files in this repo

| Path                          | What |
| ----                          | ---- |
| `flow.json`                   | The Node-RED flow. **Generated; do not hand-edit.** |
| `parser.js`                   | Canonical parser source (inlined into `flow.json`'s parser function node by `tools/build-flow.js`) |
| `layout-map.json`             | Host-specific entity bindings |
| `connection.json`             | TCP / MQTT / trace-log config |
| `tools/build-flow.js`         | Builds `flow.json` from `parser.js` + `tools/keepers.json` |
| `tools/keepers.json`          | The 14 sidewire keepers, lifted verbatim from production |
| `tests/parser-unit.js`        | Layer 1 unit tests |
| `tests/scripted-session.txt`  | Layer 2 input |
| `tests/expected-replies.txt`  | Layer 2 golden output |
| `tests/run-session.js`        | Layer 2 driver (pure Node) |
| `tests/multi-session.js`      | Layer 4 fan-out test (pure Node) |
| `tests/diff-sidewires.sh`     | Layer 5 sidewire byte-check vs production |
| `tests/sideeffects.sh`        | Layer 3 docker + mosquitto wire test |
| `tests/run-tests.sh`          | Runs Layers 1, 2, 4, 5 |
| `SPEC-NOTES.md`               | §-by-§ mapping from the ESU spec to handler functions |
| `HANDOFF.md`                  | Current state, migration plan, known coverage gaps, resumption checklist. Read this first when returning to the project. |

## What's NOT in scope

- BowmanMtn deployment. The deliverable is `flow.json`; you import it.
- Modifying `/Volumes/home-BowmanMtn/...`. This repo writes nothing there.
- The submodule deploy mechanism (`git submodule update --remote --merge`).
- Anything outside the FaCoS tab in the parent flow.

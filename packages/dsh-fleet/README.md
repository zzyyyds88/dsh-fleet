# @local/dsh-fleet

Run DeepSeek Harness on another machine and use its workspaces as if they were
local ones.

## The idea, in one paragraph

The brain stays on the node. Each machine runs its own DSH host, so `bash`, `grep`,
`git`, `read_image`, PTYs, MCP servers and skills all execute there, against that
machine's filesystem and binaries — nothing is mirrored, translated or proxied.
This plugin is the **conductor**: it keeps one warm SSH connection per node and
routes the Remote namespaces that name a Session or a Workspace to the node that
owns the identity. A remote Session therefore appears in the local sidebar as a
real Session with a real history, which is also why [`ds-harness-remote`](https://github.com/liguobao/ds-harness-remote)
forwards it to a phone without knowing this plugin exists: its `session/list`,
`session/follow` and `session/prompt` endpoints simply answer with more rows and
route accordingly.

This is the opposite of a path-translating proxy. There is no mirror directory, no
argv rewriting, no fake executable resolution and no shell dialect guessing — the
things that make proxied remote tool calls return `code=127`.

## What you get

- **Remote workspaces in the ordinary sidebar.** `workspace/follow` becomes one
  merged stream: this machine's workspaces plus every connected node's, carrying
  the node's real paths (`/root/project`, not a local mirror).
- **Remote Sessions that behave like local ones.** Create, prompt, cancel, rename,
  fork, page through history, follow live — the desktop app's normal gestures.
- **Every tool works, because it is the node's own tool.** `read`, `write`, `edit`,
  `grep`, `glob`, `bash`, `git` and `read_image` run in the node's processes against
  the node's real files. There is no mirror directory, so no tool is pointed at a
  path that does not exist.
- **Reads through the node's disk, including bytes.** `workspaceFiles/*` resolves
  the Session on the node and reads there — text and binary alike, so the file
  viewer, image preview and resource system work unchanged.
- **The phone sees the same fleet.** Because the sessions are real rows in
  `session/list`, `ds-harness-remote` forwards them; nothing needs patching.

## Why this is not a proxy (and what that buys)

`@artenx/dshb` mirrored a remote directory into a local one and sent each command
over SSH. The mirror is what broke the tools:

| Symptom | Cause under the mirror |
|---|---|
| `code=127` on `rg` / `git` / `python3` | the command was resolved against *this* machine's binaries |
| `ENOENT` from `read` / `write` / `edit` | those tools are local `node:fs` calls against the Session cwd, which named a mirror path that only existed locally |
| `read_image` never opened a remote screenshot | the bytes were read from a local path that only existed on the node |
| `grep`/`glob` missed remote files | they walked the mirror, not the node |
| MCP servers, skills, `pwsh`-vs-`bash` | all resolved against the local process |

With the brain on the node none of that exists to fix: the tools *are* the node's
tools. `test/tool-parity.mjs` and `test/tool-git-image.mjs` assert exactly this by
driving a real task and auditing the transcript for path failures and Windows paths.

## How it is wired

The plugin touches **no upstream Loader row** and imports **nothing from inside
`app.asar`**. Three runtime seams do all the work:

| Seam | What it does |
|---|---|
| own property on the live Service | `sessionController`, `workspaceController`, `workspaceFiles`, `terminalController` each get a routed method *on the instance*. The Gateway discovers endpoints from the class prototype's `@Remote` descriptor and dispatches with `Reflect.get(view, name)`, so the override wins and the declared surface does not change. |
| `typert.lookups.configure('workspaceFileScope', …)` | A `fleet_…` Session id is not a local Session, so the Host's own lookup answers `not-found` before the decorator could run. The override delegates every local id to the upstream provider verbatim and synthesises the scope object for a wrapped id. |
| `webServer.register('/fleet/api')` | Node management plus `POST /fleet/api/workspaces`, because the local directory picker browses *this* machine and can never select `/root/project` on a node. |

### The node is a brain, not a second desktop

A node is a **separate DSH installation** with its own `~/.dsh` — its own profile,
its own credential store, its own model roster. Two consequences:

1. It ships the **Web composition**, so a server with no screen loads a whole browser
   surface: 57 `dsh-client-ui-*` rows, an SPA dist server, a reload chain, desktop
   telemetry. Either it idles them or it fails to start without a dist to point at.
2. It has **no provider route and no API key**, so it boots, answers `session/list`,
   and then fails the first prompt — which from the desktop looks exactly like a
   routing bug.

The plugin closes both on every connect:

1. **The composition is customised at the source level.** The node gets its own
   profile, `~/.dsh/profiles/fleet`, whose bundle list is
   `@deepseek-ai/dsh-base` + `@local/dsh-fleet-brain` instead of
   `dsh-base` + `dsh-web-app`. The browser layer is not loaded and then disabled —
   it is **absent from the composition**, so its packages are never imported.
   *(see [`../dsh-fleet-brain`](../dsh-fleet-brain))* for how that layer is derived
   from the official one on every upstream release.
2. **Configuration goes into the profile the plugin owns**, at
   `~/.dsh/profiles/fleet/cordis.patch.yml`. That file is one of the two the node
   host hot-reloads, so a model roster or key change reaches a running node
   **without a restart and without dropping a session**. The content is copied from
   the live `configEditor.configuration()` and follows every local change: the
   plugin subscribes to this Host's `app-boot/config-reload` and
   `credentials/reference-updated`, then re-sends to every connected node.
   *(rationale and the measurements behind it:
   [`docs/adr-0001-node-config-carrier.zh.md`](../../docs/adr-0001-node-config-carrier.zh.md))*
3. **The API keys** those rows name are resolved here and pushed into the node's
   credential store over its own Remote API (`credentials/set`), so a node needs no
   manual setup and a rotated key syncs the moment you save it.

All three are idempotent (a content digest decides). The node host is restarted only
when the **brain bundle's code** changes, because modules have to be re-imported.
`connect` reports what it did under `provision` (`rows`, `refs`, `composition`).

### Identity: one string answers three questions

A remote identity crosses the boundary as `fleet_<nodeId>_<remoteId>`, e.g.
`fleet_n0123456789ab_session-1dc98667-…`. Decoding it names the node and the
identity on that node, so there is no second routing table to drift out of sync
with what the UI already holds.

Only a string that matches the full Session identity shape is rewritten. A loose
`startsWith('session-')` test also matches event *types* such as
`session-log-deepseek/delivery-accepted`, and rewriting those silently corrupts
every event the client renders.

## Requirements

- DSH 0.2.2-rc.3 (the node is installed at exactly the version this profile runs, so
  the Session format cannot skew).
- SSH access to each node, with Node 22 or newer and `npm` (used once, to install
  the resident host under `~/.dsh-fleet/runtime`).
- The node needs no open port: everything rides SSH `direct-tcpip` channels, and the
  resident host listens on the node's loopback only.

## Setup

1. **Settings › Remote nodes** (or the fleet panel in the sidebar) → *Add node*:
   host, port, user, password or private key.
2. *Connect*. The plugin probes the machine, installs the resident host if the
   version differs, starts it, and verifies the session channel before reporting
   success.
3. Expand the connected node and enter an absolute path on it (e.g. `/root/project`)
   → *Add workspace*. It appears in the sidebar's workspace list immediately,
   alongside your local ones.

Nothing else changes: local sessions, local workspaces and local tools behave
exactly as before.

## Configuration

```yaml
- id: dsh-fleet
  config:
    enabled: true
    autoConnect: true
```

`autoConnect: false` keeps every node idle until you press *Connect*.

## Endpoints that stay local, on purpose

| Endpoint | Why |
|---|---|
| `session/modelCatalog`, `session/initializeDefaultModel` | They describe *this* Host's provider roster and take no arguments. |
| `agentPresets/*`, `settings/*`, `pluginManager/*` | Configuration of this installation, not of a node. |
| `terminal/create`, `terminal/attach`, `terminal/close`, … | They take an `Agent` object resolved from a local Session; a remote Session has no local Agent. `terminal/list` and `terminal/watch` *are* routed, so the sidebar can report a remote Session's terminals. |

## Tests

| Script | What it proves |
|---|---|
| `node test/routing-unit.mjs` | Identity round-trips, stream fan-out, workspace merging, and the rule that a local call reaches the upstream method untouched. Fake fleet, no network. |
| `node test/multipart-unit.mjs` | The Gateway's `multipart/form-data` answers decode: byte attachments become `Uint8Array` at the right JSON path, and malformed parts are refused instead of silently read as `null`. |
| `node test/provision-unit.mjs` | What a node is given: provider rows copied but account routes not, the credential ref inferred even when a row omits `apiKeyEnv`, no browser row ever reaches the overlay (the composition owns that), and the rendered patch round-trips through a real YAML parser. Run it under the harness's Electron Node to get the round-trip half — the parser lives in `app.asar`. |
| `node test/gateway-smoke.mjs` | The SSH transport: cookie minting, unary RPC, and the stream carrier upgrade against a real node. |
| `node test/upstream-smoke.mjs` | The upstream controllers import and expose `static inject` from inside `app.asar`. Run under the local Electron Node. |
| `node test/dispatch-seam.mjs` | The Gateway's view of a Service resolves an own property defined on the instance. Run under the local Electron Node. |
| `node test/host-routing.mjs <base> <token>` | Every routed endpoint through the local `/api`, plus the ones that must stay local — including a **binary** read, which is what a remote image preview depends on. |
| `node test/workspace-flow.mjs <base> <token>` | The end-to-end gesture: add a remote workspace, create a Session in it, prompt it, watch the node's `bash` output arrive, and confirm the file it wrote exists on the node. |
| `node test/tool-parity.mjs <base> <token>` | The check the mirror-based approach could not pass: the agent's own `read` / `write` / `edit` / `grep` / `glob` run against the node's real paths, with no path failure and no Windows path anywhere in the transcript. |
| `node test/tool-git-image.mjs <base> <token>` | `git` on a real repository, `read_image` on a real PNG, and `grep` over real files — the three tools that returned `code=127` or `ENOENT` when the tools ran locally against a mirror. |
| `node test/client-bundle.mjs <base> <token>` | The shell serves this plugin's client module, and its three slots register and render. |

The last five need a running Host; `host-routing`, `workspace-flow`, `tool-parity`
and `tool-git-image` also need at least one connected node. Set
`DSH_FLEET_TEST_HOST` / `DSH_FLEET_TEST_USER` / `DSH_FLEET_TEST_PASSWORD` to point
them at a different machine.

Upgrading DSH? [docs/UPGRADE.zh.md](docs/UPGRADE.zh.md) lists what to re-run and
which upstream contract each test defends.

## Known limits

- **A remote Session's live stream needs an active turn.** `session/follow` on a
  cold remote Session delivers its snapshot, and later events arrive as the node's
  Agent runs. This matches local behaviour.
- **Two conductors must not share a node.** Each node's resident host is one
  process; connecting the same machine from two DSH installs is not coordinated.
- **A node offline contributes no rows**, rather than failing the sidebar: an
  unreachable node is skipped during `session/list` merging.
- **A node with an unusable credential store needs one manual fix.** If that
  machine's `~/.dsh/.credentials.yaml` is corrupt (e.g. `refs:` with no value), the
  node's own `credentials/set` refuses the push and provisioning reports the
  failure instead of silently leaving the node without a key. Fix the file there
  once; later connects keep it in step.

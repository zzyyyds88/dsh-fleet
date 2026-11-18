# @greatbaby/dsh-fleet

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
| own property on the live Service | `sessionController`, `workspaceController`, `workspaceFiles`, `jobController`, `terminalController` each get a routed method *on the instance*. The Gateway discovers endpoints from the class prototype's `@Remote` descriptor and dispatches with `Reflect.get(view, name)`, so the override wins and the declared surface does not change. |
| `typert.lookups.configure('workspaceFileScope', …)` | A `fleet_…` Session id is not a local Session, so the Host's own lookup answers `not-found` before the decorator could run. The override delegates every local id to the upstream provider verbatim and synthesises the scope object for a wrapped id. |
| `webServer.register('/fleet/api')` | Node management, `POST /fleet/api/workspaces`, `GET /fleet/api/browse` and the per-plugin switches. The local directory picker browses *this* machine and can never select `/root/project` on a node, so the plugin occupies the shell's `*.directoryFlow` slots and asks "which machine" first. |

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
3. **Add a workspace** — the plus button next to *Workspaces* (or a new Session).
   The dialog asks **which machine** first, then shows that machine's folders:
   *This machine* browses locally, a node browses over the SSH connection the plugin
   already holds. Pick a folder → *Add workspace*. It appears in the sidebar's
   workspace list immediately, alongside your local ones.

That is the same gesture for a remote folder as for a local one; the only extra
decision is which machine the folder is on.

### Which plugins run on a node

A node is a separate machine, so it composes only what you send it. **Settings ›
Remote nodes › Plugin sync** lists the plugins *you* installed here — one row per
bundle, with its version and what it contributes.

They are **sent by default**: one installation, one working environment. Switch one off
and it stays on this machine only. Four names are never sent, whichever list they are on:
this plugin itself (its preset holds the node-management tool, and a node that could
manage other nodes is the one shape of control a node must not have), the brain bundle,
and the two names of the relay plugin (a node that opened a second way in is a surface
nobody asked for).

Switching really installs it there, and the reply reports what each node did:

- a **published** plugin is installed by the node's own npm at this desktop's version
  spec, so both sides run the same release;
- a **local** plugin (`link:` in this profile, i.e. one you wrote) has no registry
  entry, so its files are copied into the node's profile instead;
- the node's bundle list becomes `dsh-base` → your plugins → the brain bundle, in that
  order, and its resident host restarts. The node must still answer afterwards — the
  test checks that, not just the switch.

Nothing else changes: local sessions, local workspaces and local tools behave
exactly as before.

### Node control: a session that can only do one thing

The same plugin ships an agent preset called **node control**. A session created from it
can list, add, update, remove, connect and disconnect nodes — and nothing else.

That is not a prompt asking the model to behave: the preset's declared plugin list *is*
the session's tool set, and it declares one tool. There is no shell, no file editor, no
web access, no subagent, no workflow. Ask it to read a file and it answers that this
session only manages nodes, and points you at the node's own workspace — where the brain
runs, so the tools run there for real.

Credentials are the one place it deliberately cannot help. Tool arguments are written into
the session log, so the tool refuses a pasted password and accepts a *reference* instead:
a private-key file that already exists on this machine (`{"kind":"key","path":"~/.ssh/id_ed25519"}`)
or the name of an environment variable (`{"kind":"password","env":"DSH_FLEET_NODE_PW"}`).
To paste a secret directly, use Settings › Remote nodes.

## Phones

`ds-harness-remote` forwards this Host's `session/*` and `workspace/*` endpoints to a
phone, and remote sessions are real rows in `session/list`, so they appear there too. A
node's filesystem is addressable inside the one path syntax that client speaks:

```
/@fleet                       → the node list
/@fleet/<nodeId>/             → that machine's filesystem root
/@fleet/<nodeId>/root/proj    → /root/proj on that machine
```

`directoryPicker/list` answers for both kinds of machine, and `workspace/create` with a
path like that creates the workspace **on the node**. The prefix is reserved for nodes;
creating a workspace from it directly is refused.

## Installation

```bash
# from npm (recommended)
dsh plugin --profile <profile> add -w @greatbaby/dsh-fleet

# from a packed tarball (offline, or to pin an exact build)
npm pack --pack-destination dist
dsh plugin --profile <profile> add -w ./dist/greatbaby-dsh-fleet-<version>.tgz

# or straight from this directory (a `link:` dependency; good for development)
dsh plugin --profile <profile> add -w <absolute path to packages/dsh-fleet>
```

Whichever form, the profile's `dsh.profile.bundles` must list this package *after*
`@deepseek-ai/dsh-base` (and after `dsh-web-app` on a desktop). `engines.dsh` pins the
runtime range, so an unsupported DSH refuses the install instead of composing half of it.

**Upgrading from before 0.5.0.** The package was renamed from `@local/dsh-fleet`, because
`@local` is another organisation's npm scope and `dsh-fleet` was already taken. The npm
scope `@greatbaby` is the publishing account's own, which needs no organisation. Remove the
old name, install the new one, and update the bundle list:

```bash
dsh plugin --profile <profile> remove @local/dsh-fleet
dsh plugin --profile <profile> add -w @greatbaby/dsh-fleet
```

Nothing on a node needs to change: the node side is the embedded
`@local/dsh-fleet-brain`, which keeps its name and never goes through a registry.

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
| `job/follow` without a `sessionId` | An unowned job is visible to every caller, so there is no Session to pick a node from; guessing would hand one node's output to another node's job id. `job/list` and `job/kill` *are* routed. |
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
| `node test/host-routing.mjs <base> <token>` | Every routed endpoint through the local `/api`, plus the ones that must stay local — including a **binary** read (what a remote image preview depends on) and the job roster (whose node-side `job/not-found` is the only way to tell routing from a silent local answer). |
| `node test/workspace-flow.mjs <base> <token>` | The end-to-end gesture: add a remote workspace, create a Session in it, prompt it, watch the node's `bash` output arrive, and confirm the file it wrote exists on the node. |
| `node test/workspace-browse.mjs <base> <token>` | Choosing a workspace folder the way the dialog does: this machine and a node answer in the same shape, the node listing is really the node's (`/` is not this machine's home, hidden folders are hidden, a missing folder reports the shell's reason), and a picked node folder becomes a workspace with the node wrapped into its id. |
| `node test/plugin-switch.mjs <base> <token>` | A per-plugin switch really lands on the node: the package is installed or copied there, the node names it in its own bundle list **before** the brain bundle, the resident host restarts, and the node still lists the same remote workspaces. Switching it off removes it again, switching it back restores the default, and the switch is restored on every exit path. |
| `node test/picker-flow.mjs <base> <token>` | The phone's view of a node: `/@fleet` lists the nodes, `/@fleet/<id>/` lists that machine's real folders with every entry spelled back inside the namespace, the breadcrumbs never go above it, and an identity this Host does not record fails by name instead of answering an empty level. Then `workspace/create` by such a path creates the workspace **on the node**, and the directory the relay made on this machine before dispatching is gone — while a file somebody put there survives. |
| `node test/picker-paths-unit.mjs` | The `/@fleet` namespace round-trips through both path normalisers (drive letter, backslashes, repeated separators, case), a malformed identity never half-matches, and the shadow cleanup cannot remove a directory with anything in it. |
| `node test/node-control.mjs <base> <token>` | The node-control preset: two declared rows, a Session created from it reports that preset, and a real turn calls `fleet_nodes` and **no other tool at all** — the observable form of "this session can only manage nodes". |
| `node test/fleet-control-unit.mjs` | The surface behind that tool: a pasted password or private key is refused (tool arguments are logged; the refusal is the feature), a reference is read on this machine, a result can never carry authentication material, and an unknown identity is a named failure rather than an empty list. |
| `node test/install-unit.mjs` | The manifest a bundle is installed from is self-consistent: every `dsh.bundle.patch` file exists and is declared, `engines.dsh` is a range npm understands, `files` covers every runtime artefact, `locale.meta.detail` names a file that is really there, and no shipped file carries a LAN address or a private key. |
| `node test/tool-parity.mjs <base> <token>` | The check the mirror-based approach could not pass: the agent's own `read` / `write` / `edit` / `grep` / `glob` run against the node's real paths, with no path failure and no Windows path anywhere in the transcript. |
| `node test/tool-git-image.mjs <base> <token>` | `git` on a real repository, `read_image` on a real PNG, and `grep` over real files — the three tools that returned `code=127` or `ENOENT` when the tools ran locally against a mirror. |
| `node test/client-bundle.mjs <base> <token>` | The shell serves this plugin's client module; its three own slots plus the three folder-picker slots register and render. |
| `node test/event-relay.mjs <base> <token>` | A Session created **on the node** reaches the browser: its `api-session/*` list events and its `session/control` projections both arrive under the wrapped identity. This is what makes a remote row's title, spinner and new-Session insertion happen live instead of on the next full list pull. |

The last six need a running Host; `host-routing`, `workspace-flow`, `tool-parity`,
`tool-git-image` and `event-relay` also need at least one connected node. Set
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

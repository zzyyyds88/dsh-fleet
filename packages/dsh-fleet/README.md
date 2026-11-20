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
- **A dropped connection is visible, and it comes back by itself.** The node card goes
  to *disconnected, reconnecting* with a timestamp instead of staying green over a dead
  socket; the ladder is 2s / 4s / 8s, then every 2 minutes until it succeeds or you
  press *Disconnect*. The workspace rows stay listed (marked offline) rather than
  vanishing and reappearing.
- **A failure names one thing to do.** Every failed connect is classified into
  `{code, message, action, retryable, detail}`; the card turns `action` into a button.
  A wrong password gets no retry button, because pressing it would produce the same
  failure again.
- **Each node keeps its own last 100 log lines**, redacted on write, readable from its
  card or `GET /fleet/api/nodes/<id>/log` — the desktop-wide log mixes every node and
  plugin together and is not where someone with a red card looks.
- **Per-plugin switches decide what runs on the node.** Every third-party bundle you
  installed here is sent there by default; switch one off and it stays local. A switch
  really installs or copies the package on the node, rewrites the node's bundle list and
  restarts its resident host — and the reply says what each node did.

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
`app.asar`** (the client half `require`s `@deepseek-ai/dsh-client-ui-primitives` at
runtime, which is what makes its dialogs behave like the shipped ones). Five runtime
seams do the work; the full reasoning is in
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §三.

| Seam | What it does |
|---|---|
| own property on the live Service | `sessionController`, `workspaceController`, `workspaceFiles`, `jobController`, `terminalController` each get a routed method *on the instance*. The Gateway discovers endpoints from the class prototype's `@Remote` descriptor and dispatches with `Reflect.get(view, name)`, so the override wins and the declared surface does not change. |
| `typert.lookups.configure('workspaceFileScope', …)` | A `fleet_…` Session id is not a local Session, so the Host's own lookup answers `not-found` before the decorator could run. The override delegates every local id to the upstream provider verbatim and synthesises the scope object for a wrapped id. |
| `typert.lookupStore.resolvers`'s `agent` entry | The public `configure` is already taken by upstream (a second call on the same key throws), so the resolver table is the only place left to answer "which Agent owns this `fleet_…` id". |
| the Gateway's pending-event table | Upstream's only local waterfall entry point wants a carrier that only `@deepseek-ai/dsh-scope` can build. The plugin builds a same-shaped pending entry into `pendingRemoteEvents` and lets upstream deliver and settle it. |
| HTTP and RFC 6455 over SSH `direct-tcpip` | A node opens no port, so every `/api` call and the `$events` stream ride an SSH channel. Two traps: the Gateway pings every 2 s and drops the carrier on silence, and a result carrying bytes is **not** JSON (`Uint8Array` arrives as `null`) — it comes back as `multipart/form-data`. |

Plus one non-seam: `ctx.webServer.register({ prefix: '/fleet/api' })` for the plugin's own
management surface, and the shell's three `*.directoryFlow` slots, which the plugin takes
over to ask "which machine" before browsing.

### The node is a brain, not a second desktop

A node is a **separate DSH installation** with its own `~/.dsh` — its own profile,
its own credential store, its own model roster. Two consequences:

1. It ships the **Web composition**, so a server with no screen loads a whole browser
   surface: 56 `dsh-client-ui-*` rows, an SPA dist server, a reload chain, desktop
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

- DSH 0.2.2 (the node is installed at exactly the version this profile runs, so the
  Session format cannot skew). `engines.dsh` is `>=0.2.2-rc.3 <0.3.0`: anything in the
  0.2.2 line installs, 0.3.0 is refused rather than half-composed.
- SSH access to each node, with Node 22 or newer. `curl` (or `wget`) *or* `npm` — the
  runtime arrives one of two ways: a published artefact is downloaded if an accelerator
  can serve it, and otherwise the node resolves the exact same release itself with
  `npm install`. Only a machine with neither a downloader nor `npm` cannot be set up.
- `@deepseek-ai/dsh` declares `engines.node: ">=24.9.0"` for every 0.2.2 release, while
  this plugin's floor is Node 22. A node below the declared engines still installs and
  runs (the artefact route never read that field either) — the settings page just says so.
  The measurement behind keeping 22 is in `docs/adr-0006-node-runtime-supply.zh.md` §四-2.
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

### How the node's DSH gets there

Two routes, tried in order (`runtime` in the config: `auto` / `artefact` / `npm`):

1. **A published artefact** — `dsh-<version>-<platform>.tar.gz` from a Release. One file,
   no registry. The sources are tried in order and the list lives in
   `DEFAULT_SOURCES` (`src/remote/artefact.js`): **CNB first**, then the GitHub
   accelerators as disaster recovery. Measured on the reference node with the full
   165 MiB archive: CNB served it at 4 233 285 B/s (~33 s, spread under 1% across
   repeats) while the accelerators ranged 0.2–9.6 MB/s run to run — a 40× spread,
   which is the difference between "connecting" and "hanging".
2. **The node resolves it itself** — `npm install --os/--cpu/--libc
   "@deepseek-ai/dsh@<exact version>"` on the node. Slower (a full resolve, measured
   26–33 s for 673 packages), but it needs no artefact at all: that is what makes an
   upstream DSH release followable without anyone pre-building a tree.

Which one to skip is decided by *why* the first failed. A tree that could not be
**had** — every source down, no `curl`/`wget`, `mirrors: []` — falls through to
`npm`. A tree that arrived and was **wrong** (bad checksum, bad archive, no CLI inside)
rolls back and reports: re-resolving the same broken release would download more and
hide which source was at fault.

Both routes stamp the tree with the same build id, so the next connect recognises it
either way. The node card shows which route it used.

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

### How a bundle's files travel to the node

Both tree writers (`writeBrainBundle`, `writePluginBundle`) put the payload on **stdin**,
and that is a hard requirement rather than a preference. `ssh2` writes an `exec` request as
one SSH packet however long the command is, and OpenSSH's `PACKET_MAX_SIZE` is 256 KiB; a
plugin tree on the command line therefore crosses the ceiling, and the server does not
answer with an error — it loses packet alignment and drops the connection
(`Bad packet length …` / `Connection corrupted`).

Measured on the reference node with a single connection: a 262,200-byte command line
produced six corrupted connections, while the same 7.9 MB on stdin produced none. The
`7923616` that filled that log was `writePluginBundle`'s command line for
`dsh-whale-widget`, to within the script's own tail.

`SshConnection.exec` also refuses a command line over `MAX_COMMAND_BYTES` (128 KiB) locally,
because a local error is the only outcome a caller can act on. `test/packet-unit.mjs`
pins all of this.

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
    # How a node gets its DSH: auto (default, artefact then npm),
    # artefact (published tree only), or npm (let the node resolve it).
    runtime: auto
    # Where an artefact is fetched from, best first. Omit to use
    # DEFAULT_SOURCES: CNB, then the GitHub accelerators. A template
    # source fills in {version} {platform} {tag} {file}; a prefix source
    # is prepended to the GitHub release URL.
    sources:
      - kind: template
        template: https://cnb.cool/serendipity-archive/dsh-fleet/-/releases/download/{tag}/{file}
      - kind: prefix
        prefix: https://gh.inkchills.cn/
    # Shorthand for the prefix sources only; an empty list turns the
    # artefact route off, which falls through to npm.
    mirrors: [https://git.yylx.win/, https://gh.inkchills.cn/]
    # Registry the *node* uses when it resolves the release itself.
    # Omit to use the node's own `npm config get registry`.
    registry: https://registry.npmmirror.com
```

`autoConnect: false` keeps every node idle until you press *Connect*.

`runtime` exists so a failure can be attributed: `artefact` turns a download problem into a
named error instead of a slower connect, and `npm` is how you check whether the node's own
registry works at all. `registry` is passed through to the node's `npm install --registry`;
leaving it out is usually right, because the node knows its own network.

`sources` and `mirrors` are not the same knob. `sources` is the whole ordered list, including
hosts with their own URL layout; `mirrors` only names accelerators, which is why it is kept —
it is what a person usually wants to change. Setting `mirrors: []` is the documented way to
switch the artefact route off entirely, and it does *not* leave CNB as a lone source.

## Endpoints that stay local, on purpose

| Endpoint | Why |
|---|---|
| `session/modelCatalog`, `session/initializeDefaultModel` | They describe *this* Host's provider roster and take no arguments. |
| `agentPresets/*`, `settings/*`, `pluginManager/*` | Configuration of this installation, not of a node. |
| `job/follow` without a `sessionId` | An unowned job is visible to every caller, so there is no Session to pick a node from; guessing would hand one node's output to another node's job id. `job/list` and `job/kill` *are* routed. |
| `terminal/create`, `terminal/attach`, `terminal/close`, … | They take an `Agent` object resolved from a local Session; a remote Session has no local Agent. `terminal/list` and `terminal/watch` *are* routed, so the sidebar can report a remote Session's terminals. |

## Tests

```bash
node test/run-all.mjs                            # all 35, right interpreter per suite
node test/run-all.mjs --layer offline,contract   # the two layers that need no node
node test/run-all.mjs --list                     # the matrix, without running
```

A suite that cannot run here exits 3 and is reported **SKIP with a reason**, never as a
pass; `--layer e2e` that could not run a single suite exits non-zero.

| Layer | Suites | What it covers | Needs |
|---|---|---|---|
| `offline` | 14 | Identity round-trips and routing by each namespace's own shape; multipart decoding; what provisioning writes (and what it must not); approval relay bookkeeping; version gate and artefact URLs; the connect lifecycle (dropped socket → `idle`, reconnect ladder, host key, failure phase, offline rows kept); error classification and log redaction; the `/@fleet` path namespace; install-manifest self-consistency; autoconnect; the node-control surface; the brain composition; and the SSH packet ceiling. | Node 22, except `provision` and `composition`, which read `app.asar` and need the Electron Node |
| `contract` | 3 | The upstream seams: `@Remote` descriptors and `static inject` are readable; the Gateway still dispatches to an own property on the instance; the controllers the wrappers decorate still export what they expect. | The installed DSH, under its Electron Node |
| `e2e` | 18 | Everything that needs a real Host and a real node: transport, every routed endpoint, workspace add/browse/pick, plugin switch, the agent's own tools, git and `read_image`, client bundle, event relay, remote turn, PTY, two nodes at once, both runtime routes, approval round-trip, node-control preset, browser. | A running Host + SSH-reachable node; `browser` also needs `DSH_BROWSER_DEBUG_PORT` |

`node test/run-all.mjs --list` prints the one-line contract of each suite, and
[docs/ACCEPTANCE.zh.md](docs/ACCEPTANCE.zh.md) records what passed in each round with the
numbers.

Set `DSH_FLEET_TEST_HOST` / `DSH_FLEET_TEST_USER` / `DSH_FLEET_TEST_PASSWORD` (or
`DSH_FLEET_TEST_KEY_FILE`) to point the e2e layer at a machine. There are no defaults in
the source: this repository is public.

Upgrading DSH? [docs/UPGRADE.zh.md](docs/UPGRADE.zh.md) lists what to re-run and which
upstream contract each test defends.

## Known limits

- **A node keeps its own MCP servers and its own `~/.dsh/skills`.** Provisioning copies
  the provider routes, the default model, the permission preset and the credential refs
  those rows name — nothing else. `mcpManager`'s server table is a per-Host volatile
  config with no cross-machine transfer, and skill directories are enumerated by each
  Host with `node:fs` over its own home. A node therefore has the runtime's packaged
  skills (`dsh-doc`, the office set) and no MCP server you configured here.
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
- **A `MaxSessions` budget is per connection, and it is finite.** `sshd` allows ten
  session channels per connection by default, and every `exec` and every forwarded HTTP
  exchange is one. A burst on a healthy connection hits the ceiling and ssh2 reports
  `Channel open failure: open failed`. The plugin retries on the same connection with a
  short backoff first, and only when that fails drops and re-handshakes for a fresh
  budget — measured: filling the budget with ten long execs left that connection refusing
  channels for the whole 40 s window, because closing a channel whose remote command is
  still alive does not free its slot.

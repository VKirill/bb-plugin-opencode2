# OpenCode v2 provider for BB

This plugin lets BB run threads through an installed OpenCode v2 service.
OpenCode owns the model connection, model credentials, and its own tool
execution. The plugin translates between OpenCode events and BB's provider
bridge protocol.

OpenCode v2 is still beta. This README describes what this plugin implements,
not everything OpenCode or BB can do with another provider.

## What you need

- BB 0.41 or newer
- BB Plugin SDK 0.4.34 or newer
- The `opencode2` command on the machine running the provider host

Install OpenCode v2 from its own documentation:

<https://opencode.ai/v2/docs/>

Install this plugin from the repository root:

```sh
bb plugin install .
```

BB shows OpenCode v2 in the provider picker only when the `opencode2` command
is installed and the provider is enabled.

OpenCode handles login and model-provider setup. Open a thread and use
OpenCode's normal `/connect` flow when it asks for credentials.

## Supported BB features

| BB feature                    | Support              | Details                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider picker               | Yes                  | The provider is visible when `opencode2` is installed and enabled.                                                                                                                                                                                                                                                         |
| Model discovery               | Yes                  | Models come from OpenCode's workspace API. The plugin can allow or block individual models in its settings.                                                                                                                                                                                                                |
| New threads                   | Yes                  | BB creates an OpenCode session and keeps the provider session ID.                                                                                                                                                                                                                                                          |
| Resume threads                | Yes                  | BB can reconnect to an existing OpenCode session.                                                                                                                                                                                                                                                                          |
| Fork at a checkpoint          | Yes                  | BB asks OpenCode to fork retaining through a provider checkpoint. Fork creates a child session for a new BB thread.                                                                                                                                                                                                        |
| Rewind thread                 | Yes                  | Same-BB-thread rewinds truncate the OpenCode session in place via revert (stage + commit with file restore) instead of forking, keeping the session ID.                                                                                                                                                                    |
| Edit message                  | Yes                  | Editing a past user message rewinds through the previous checkpoint and resends the edited prompt. Every turn emits a `providerCheckpointId` (including steered prompts).                                                                                                                                                  |
| Send prompts                  | Yes                  | Text, local files, local images, and image URLs are passed to OpenCode.                                                                                                                                                                                                                                                    |
| Steering                      | Yes                  | Follow-up input is queued through OpenCode's prompt endpoint and confirmed with `input.accepted` so BB clears Steer pending. Steers also refresh the turn checkpoint.                                                                                                                                                      |
| Stop                          | Yes                  | BB interrupts the active OpenCode session.                                                                                                                                                                                                                                                                                 |
| Discard                       | Yes                  | BB deletes the OpenCode session and removes the plugin's temporary tool bridge.                                                                                                                                                                                                                                            |
| Rename threads                | Yes                  | BB forwards the new title to OpenCode.                                                                                                                                                                                                                                                                                     |
| Manual `/compact`             | Yes                  | BB's standalone built-in `/compact` command calls OpenCode's compaction endpoint and shows the compaction item and result.                                                                                                                                                                                                 |
| Permission mode: accept edits | Yes                  | OpenCode permission requests appear in BB's approval UI.                                                                                                                                                                                                                                                                   |
| Permission mode: auto         | Yes                  | OpenCode receives a one-time approval for each matching request.                                                                                                                                                                                                                                                           |
| Permission mode: full         | Yes                  | OpenCode receives a persistent approval for matching requests.                                                                                                                                                                                                                                                             |
| Reasoning levels              | Yes                  | BB advertises none, low, medium, high, xhigh, max, and ultra. The available OpenCode model variants decide which levels actually appear for a model. BB reasoning selections are sent as OpenCode model variants (`provider/model#variant`) at session start and via the session model-switch endpoint before each prompt. |
| Native user questions         | Yes                  | OpenCode question forms are converted into BB's native question interaction.                                                                                                                                                                                                                                               |
| BB dynamic tools              | Yes                  | BB and plugin-provided dynamic tools are exposed to OpenCode through a per-session local MCP server. Tool calls return through BB's `item/tool/call` protocol.                                                                                                                                                             |
| BB CLI on PATH                | Yes                  | OpenCode session shells get a codex-style environment with BB's per-session envVars and the `bb` binary directory prepended to `PATH`.                                                                                                                                                                                     |
| Dynamic-tool restrictions     | Partial              | `disallowedTools` removes matching dynamic tools from the MCP catalog. It cannot filter every native OpenCode tool.                                                                                                                                                                                                        |
| Native subagent policy        | Yes, with a limit    | Native OpenCode `task` or `subagent` use is disabled by default. The plugin rejects permission requests and surfaces the disabled warning on the failed tool result. Prompts are sent unchanged. BB remains the place to delegate work.                                                                                    |
| Skills                        | Yes                  | Native OpenCode skills use skill mentions. Skills that OpenCode has not discovered are attached as `SKILL.md` files.                                                                                                                                                                                                       |
| Read and search rows          | Yes                  | Recognized reads, directory listings, content searches, and path searches use BB's native timeline rows.                                                                                                                                                                                                                   |
| Shell command rows            | Yes                  | Recognized shell commands use BB's native command rows.                                                                                                                                                                                                                                                                    |
| Web rows                      | Yes                  | Recognized web search and fetch tools use BB's native web rows.                                                                                                                                                                                                                                                            |
| File-change rows              | Yes                  | Write, edit, and patch tools are represented as BB file-change rows with a Git diff when one is available.                                                                                                                                                                                                                 |
| Usage during a turn           | Yes                  | Token totals from OpenCode step events are sent to BB.                                                                                                                                                                                                                                                                     |
| Provider errors               | Yes                  | OpenCode failures are sent as visible BB provider errors and as a failed turn boundary.                                                                                                                                                                                                                                    |
| Large tool results            | Yes, with truncation | Timeline values are bounded to 64 KiB per emitted delta. Large text keeps its beginning and end with a truncation marker.                                                                                                                                                                                                  |
| Plugin settings               | Yes                  | The settings page controls provider enablement, the model allowlist, and whether native OpenCode subagents are disabled.                                                                                                                                                                                                   |

## Unsupported BB features

These are declared as unsupported by the provider. BB will not pretend that
the plugin can perform them.

| BB feature                           | Status       | What happens                                                                                                                                                                     |
| ------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive and unarchive                | No           | BB cannot mirror archive state to OpenCode.                                                                                                                                      |
| Thread goals                         | No           | The provider does not implement BB's goal-clear operation.                                                                                                                       |
| Service tiers                        | No           | BB does not offer a service-tier picker for this provider.                                                                                                                       |
| Provider usage dashboard             | No           | The provider does not expose the sessionless BB usage-maintenance API. Per-turn token usage still works.                                                                         |
| Provider installation and updates    | No           | The plugin does not install or update OpenCode. Install the `opencode2` command yourself.                                                                                        |
| Provider login UI                    | No           | Credentials are configured by OpenCode's `/connect` flow.                                                                                                                        |
| BB plan composer action              | No           | The provider does not opt into BB's plan composer action. OpenCode's own planning behavior is separate.                                                                          |
| Native OpenCode tool denylist        | No           | OpenCode v2 has no supported per-prompt native-tool filter in the API used here. Dynamic BB tools are filtered, but `disallowedTools` does not block every native OpenCode tool. |
| Exact instruction replacement mode   | No           | OpenCode's session instruction entry has no BB append/replace selector. The plugin cannot reproduce BB's `instructionMode: "replace"` contract exactly.                          |
| Exact native subagent tool filtering | No           | The API does not provide a native per-prompt `task` or `subagent` disable switch. The plugin uses prompt guidance and permission rejection instead.                              |
| Live MCP cleanup proof               | Not verified | The bridge removes its MCP registration on normal discard, but the shared OpenCode service was not mutated in the automated tests.                                               |

## How the bridge works

The plugin connects to OpenCode's single shared background service only when a
thread needs it. Sharing the service matters because OpenCode stores the
session state there, and BB may resume the thread from another host worker.

For BB dynamic tools, the plugin starts a local, session-specific MCP process.
OpenCode sees the configured tools, while the plugin checks the session and a
random token before forwarding each call to BB. BB re-sends session
construction around turns even when nothing changed, so re-registration is
idempotent: an unchanged tool catalog keeps the live MCP child instead of
respawning it per message. Closing or discarding the BB thread closes the
local proxy and removes its OpenCode MCP registration; a persisted registry
lets discards clean up even when another host worker owns the thread.

Codex agents inherit the host `PATH` (which carries the `bb` binary), but
OpenCode shells run under the shared background service whose environment is
fixed at service start. The plugin sends each session a filtered host
environment and removes incidental credentials. It then overlays BB's explicit
per-session `envVars` and prepends the resolved `bb` binary directory to
`PATH`.

BB skill roots and slash-command mentions are translated into OpenCode's
prompt format. Native OpenCode skill IDs become skill mentions. Other BB skill
roots become `SKILL.md` file attachments.

The plugin keeps useful BB timeline rows for common OpenCode tools. It hides
duplicate raw write and edit rows because the resulting file-change row is
more useful in BB.

## Settings

Open the plugin settings page in BB.

- **Provider enabled** controls whether OpenCode v2 appears in the provider picker.
- **Disable provider subagents** keeps native OpenCode `task` and `subagent` use disabled. It is enabled by default.
- **Enable all** and **Disable all** control the model allowlist.
- The model search field filters the models returned by OpenCode.

## Code layout

`host.ts` only exposes the host contract and public test helpers. The host
implementation lives under `host/`:

- `provider-bridge.ts` validates and dispatches provider protocol requests.
- `opencode-server.ts` owns the CLI connection, HTTP client, persistence, and
  event-stream lifecycle.
- `opencode-event-router.ts` translates OpenCode events into BB deltas.
- `session-manager.ts` owns session setup, model policy, MCP registration, and
  shutdown.
- `timeline.ts`, `tool-mapping.ts`, `prompt.ts`, `models.ts`, and
  `opencode-requests.ts` contain the testable protocol mappings.

The settings UI follows the same pattern: `app.tsx` registers the slot and
`app/settings-section.tsx` implements it.

## Development

```sh
bb plugin types
npm run check
```

`npm run check` verifies formatting, typechecks every source and test file,
builds all plugin artifacts, scans imports for private SDK use, runs the Node
test suite against the built host artifact, and mounts the settings UI in
jsdom. The focused tests
cover provider registration, permission mapping, compaction mapping, skill
translation, dynamic-tool calls, tool-catalog comparison, session environment
setup, fork/rewind checkpoint boundaries, and oversized timeline values.

The tests do not start a real user OpenCode session. In particular, they do
not prove live MCP registration, live OpenCode compaction, or BB's persisted
timeline rendering.

## OpenCode documentation

- <https://opencode.ai/v2/docs/>
- <https://opencode.ai/v2/docs/api>
- <https://opencode.ai/v2/docs/mcp-servers>
- <https://opencode.ai/v2/docs/compaction>

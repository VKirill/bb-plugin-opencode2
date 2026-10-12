# OpenCode v2 provider for BB

This plugin lets BB run threads through an installed OpenCode v2 service.
OpenCode owns the model connection, model credentials, and its own tool
execution. The plugin translates between OpenCode's v2 API and events and
BB's provider bridge protocol.

Verified against OpenCode 2.0.26–2.0.27 and BB 0.46 (Plugin SDK 0.6.37).

## What you need

- BB 0.46 or newer
- OpenCode v2 2.0.26 or newer (`opencode2` on the host's PATH). BB can
  install it (`npm install -g @opencode/cli`) or update it
  (`opencode2 upgrade`) from the provider settings.
- At least one model provider connected in OpenCode: `opencode2 auth login`

Install this plugin from the repository root:

```sh
bb plugin install .
```

BB shows OpenCode v2 in the provider picker when `opencode2` is installed and
the provider is enabled in the plugin settings.

## Supported BB features

| BB feature            | Details                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider picker       | Visible when `opencode2` is installed and the provider is enabled.                                                                                                                                                                         |
| Health                | Reports not installed, unsupported version, no model provider connected, or service unreachable, with the command to fix it.                                                                                                               |
| Install and update    | Install through npm; update through `opencode2 upgrade`, which handles npm, bun, brew, and curl installs.                                                                                                                                  |
| Model discovery       | Models come from OpenCode for the thread's workspace. OpenCode's default model is BB's default. The settings page can allow or block individual models.                                                                                    |
| Reasoning levels      | BB levels map to each model's OpenCode variants (`minimal` serves as low and `thinking` as high when the model lacks those levels). Models without variants run on their defaults.                                                         |
| New, resumed threads  | BB creates or reconnects to an OpenCode session and keeps its ID.                                                                                                                                                                          |
| Fork at a checkpoint  | Forks copy history through the checkpoint turn into a new OpenCode session.                                                                                                                                                                |
| Rewind and edit       | Same-thread rewinds and message edits revert the OpenCode session in place, restoring files.                                                                                                                                               |
| Prompts               | Text, local files, local images, and image URLs.                                                                                                                                                                                           |
| Steering              | Follow-up input is queued into the running OpenCode turn.                                                                                                                                                                                  |
| Stop, discard, rename | Stop interrupts the session; discard deletes it and its BB tool server; rename sets the OpenCode title.                                                                                                                                    |
| Manual `/compact`     | Runs OpenCode compaction; automatic compactions also appear in the timeline.                                                                                                                                                               |
| Plan mode             | `/plan` runs the turn on OpenCode's read-only `plan` agent. The next normal turn returns to `build`.                                                                                                                                       |
| Permission modes      | Encoded as OpenCode session rules. Accept edits asks before shell, web, and other non-edit tools; auto answers OpenCode's remaining asks once; full allows everything. A denial goes back to the agent as feedback and the turn continues. |
| Questions             | OpenCode's question tool uses BB's native question UI.                                                                                                                                                                                     |
| BB dynamic tools      | Exposed to OpenCode through a per-session local MCP server, rendered with the presentation BB supplies, and approved by BB rather than prompting twice.                                                                                    |
| BB CLI in shells      | OpenCode shells get BB's per-session environment and `bb` on `PATH`.                                                                                                                                                                       |
| Native subagents      | Off by default: OpenCode's `subagent` tool is denied and hidden, so agents delegate through BB. When allowed, each subagent is a BB delegation row with its work nested inside.                                                            |
| Skills                | OpenCode-native skills use skill mentions; other BB skills are attached as `SKILL.md` files.                                                                                                                                               |
| Timeline rows         | Reads, searches, directory listings, web search and fetch, commands with live output and exit codes, and file changes built from OpenCode's own patches.                                                                                   |
| Turn diff             | Each turn's file patches are reported as the turn diff.                                                                                                                                                                                    |
| Usage and context     | OpenCode's cumulative session tokens, the last request's tokens, and the model's context limit drive BB's usage and context meter.                                                                                                         |
| Errors and retries    | Failures settle the turn with a visible error; scheduled model retries show as retrying errors.                                                                                                                                            |
| Recovery              | OpenCode's event stream does not replay. After a reconnect, and every 30 seconds, turns whose OpenCode session already went idle are settled from its recorded outcome.                                                                    |
| Large tool results    | Timeline values are bounded to 64 KiB per delta, keeping the beginning and end.                                                                                                                                                            |

## Not supported

OpenCode v2 has no API for these, so the provider declares them unsupported.

| BB feature                        | Why                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Archive and unarchive             | Sessions record an archive time, but the API cannot set it.                                  |
| Thread goals                      | No equivalent in OpenCode.                                                                   |
| Service tiers                     | No equivalent in OpenCode.                                                                   |
| Usage dashboard                   | OpenCode exposes cost totals, not rate-limit windows. Per-turn usage still works.            |
| `instructionMode: "replace"`      | Session instruction entries add to OpenCode's own instructions; they cannot replace them.    |
| Filtering native tools per prompt | `disallowedTools` filters BB dynamic tools; native OpenCode tools have no per-prompt switch. |

## Settings

Open the plugin settings page in BB (Settings → OpenCode v2).

- **Status** shows each connected host's OpenCode version, available updates,
  and model count, with the command to run when something is missing.
- **Show in the provider picker** enables or hides the provider.
- **Allow OpenCode subagents** lets OpenCode use its native subagents (off by
  default).
- **Models** controls the allowlist, grouped by OpenCode provider.

Settings apply from the next turn. See
[`skills/opencode2-provider/SKILL.md`](skills/opencode2-provider/SKILL.md) for
the CLI equivalents and troubleshooting.

## How the bridge works

The plugin connects to OpenCode's single shared background service only when
a thread needs it, and never stops it. Sharing the service matters because
OpenCode stores session state there, and BB may resume a thread from another
host worker.

For BB dynamic tools, the plugin starts a local, session-specific MCP
process. OpenCode sees the configured tools, while the plugin checks the
calling session and a random token before forwarding each call to BB. An
unchanged tool catalog keeps the live MCP child across BB's repeated session
setup. Discarding the thread removes its OpenCode MCP registration; a
persisted registry lets discards clean up even when another host worker owns
the thread.

OpenCode shells run under the background service, whose environment is fixed
at service start. The plugin sends each session a credential-filtered host
environment, BB's per-session `envVars`, and `PATH` with the `bb` binary
directory first.

## Code layout

`host.ts` exposes the host contract and public test helpers. The host
implementation lives under `host/`:

- `provider-bridge.ts` validates and dispatches provider protocol requests.
- `opencode-server.ts` owns the service connection, HTTP client, model
  catalog, persistence, event stream, and turn reconciliation.
- `opencode-event-router.ts` translates OpenCode events into BB deltas,
  including live shell output and subagent nesting.
- `session-manager.ts` owns session setup, per-turn preparation (settings,
  permissions, plan mode, model), MCP registration, and shutdown.
- `maintenance.ts` implements health, install, and update.
- `opencode-requests.ts`, `timeline.ts`, `tool-mapping.ts`, `prompt.ts`, and
  `models.ts` contain the testable protocol mappings.

The settings UI follows the same pattern: `app.tsx` registers the slot and
`app/settings-section.tsx` implements it. `plan.md` tracks remaining work.

## Development

```sh
bb plugin types
npm run check
```

`npm run check` verifies formatting, typechecks every source and test file,
builds all plugin artifacts, runs the Node test suite against the built host
artifact, and mounts the settings UI in jsdom. `opencode-v2-contract.test.ts`
pins the request and event shapes verified against a live OpenCode 2.0.27
service.

## OpenCode documentation

- <https://opencode.ai/v2/docs/>
- <https://opencode.ai/v2/docs/api>

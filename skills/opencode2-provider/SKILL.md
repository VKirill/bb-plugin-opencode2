---
name: opencode2-provider
description: "Inspect, configure, or troubleshoot the BB OpenCode v2 provider: install and version, connecting model providers, model allowlist, native subagents, permission modes, and plan mode."
---

# OpenCode v2 provider

The `opencode2` provider runs BB threads through the shared OpenCode v2
background service on each host (`opencode2 service status` prints its URL).
OpenCode owns model credentials; BB never stores them.

## Check status

```sh
echo '{}' > /tmp/empty.json
bb plugin rpc call opencode2 getStatus --input-file /tmp/empty.json --json
```

Per connected host this reports `ready`, `not_installed`,
`unsupported_version` (older than the minimum in the result),
`unauthenticated` (no usable models), or `unknown` (service unreachable),
plus the installed and latest OpenCode versions and the model count.

- Not installed: `npm install -g @opencode/cli`, or BB's provider install
  action.
- Outdated: `opencode2 upgrade` (works for npm, bun, brew, and curl installs).
- No models: `opencode2 auth login` on that host, then refresh models.

## Settings

Read with `bb plugin rpc call opencode2 getSettings --json`; change through
the plugin settings page or `saveSettings` with the full object:

- `providerEnabled`: show OpenCode v2 in the provider picker.
- `enabledModels`: `null` for every model, or an exact allowlist of
  `provider/model` IDs (`[]` hides all).
- `disableSubagents` (default `true`): when `true`, OpenCode's native
  `subagent` tool is denied and hidden; delegate with BB threads instead.
  When `false`, OpenCode subagents render as BB delegation rows.

Settings apply from the next turn.

## Behavior to expect

- Permission modes become OpenCode session rules. `accept-edits` asks for
  shell, web, and other non-edit tools; `full` allows everything. A denial is
  returned to the agent as feedback, and the turn continues.
- `/plan` runs the turn on OpenCode's read-only `plan` agent; the next normal
  turn switches back to `build`.
- Reasoning levels map to the model's OpenCode variants. Models without
  variants run on their defaults whatever level is picked.
- Not supported: thread archive, goals, service tiers, the usage dashboard,
  and `instructionMode: "replace"` (BB instructions are added to OpenCode's).

## Troubleshooting

- A turn that seems stuck: the bridge reconciles turns with OpenCode every
  30 seconds and after the event stream reconnects, so it settles once
  OpenCode reports the session idle.
- Stale `bb_opencode2_*` MCP servers in `GET /api/mcp`: discarding the
  thread removes its server; they are harmless otherwise.
- Plugin logs: `~/.bb/plugins/opencode2/logs/plugin.log`.

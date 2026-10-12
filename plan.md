# OpenCode v2 provider — stabilization and full bb feature plan

Last updated: 2026-10-12. Targets: bb 0.46.0 (Plugin SDK 0.6.37), OpenCode v2.0.27.

## 0. Resume checklist (read first)

1. Work on `main` and commit after each verified step (user preference; no
   branches).
2. Phase 1 is committed. Continue with §4 Phase 2, in order.
3. Live smoke harness (scenarios `s1`–`s7` cover everything verified): `/tmp/claude-501/smoke/harness.mjs` plays the bb
   runtime against `dist/host.js`, and `s1.mjs` is the Phase 1 scenario.
   Run both unsandboxed, because the OpenCode service isn't reachable from
   the sandbox. `cleanup.mjs <dist/host.js> <ws>` removes leftover
   `bb_opencode2_*` MCP servers and test sessions. `/tmp` may be wiped; if
   so, recreate the harness. It handles `interaction/request` and
   `item/tool/call`, uses `creq_` + 10-char client request IDs, and sends the
   full permission policy (`permissionScope`, `approvalReviewer`,
   `permissionEscalation`).
4. Talking to the live service: `opencode2 service status` prints the URL.
   Basic auth uses `opencode:<password>` from
   `~/.config/opencode/service.json`. Every location-scoped route needs
   `?location[directory]=<cwd>`.
5. For cheap live tests, use the free model `opencode/space-bunny-free`
   (variants low/medium/high/xhigh/max) or `opencode/mimo-v2.6-flash-free`
   (no variants). Always delete scratch sessions.

## 1. Assessment: how ready was it?

The plugin was not usable as a stable provider. It was written in early
September against an older OpenCode v2 beta and Plugin SDK 0.4.34. OpenCode's
API has since moved, so core flows break or silently do the wrong thing.

### Broken against OpenCode 2.0.27 (verified live)

| #   | Problem                                                                                                                                     | Effect                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | MCP register/remove used `/api/mcp/:server`. The route is now `/api/experimental/mcp/:server`.                                              | Route 404s. Session setup throws for any thread that has bb dynamic tools.                                                             |
| B2  | Instructions used `/api/session/:id/instructions/entries/:key`. The route is now `/api/experimental/session/:id/instructions/entries/:key`. | Route 404s. Session setup throws for any thread that has bb instructions, so most threads fail to start.                               |
| B3  | Rename used `POST /api/session/:id/rename`.                                                                                                 | The route doesn't exist. Use `PATCH /api/session/:id {title}`.                                                                         |
| B4  | Revert-clear used `POST .../revert/clear`.                                                                                                  | The route doesn't exist. Use `DELETE /api/session/:id/revert`.                                                                         |
| B5  | Form cancel used `POST .../form/:id/cancel`.                                                                                                | The route doesn't exist. Use `DELETE /api/session/:id/form/:formId` (optional `?message=`).                                            |
| B6  | Permission reply sent `{reply}`.                                                                                                            | Fails with 400. The body must be `{decision: "once"\|"always"\|"reject", message?}`. Approvals never resolve, so turns hang.           |
| B7  | Fork sent `{boundary:{type,messageID}}`.                                                                                                    | Unknown keys are stripped, so every fork copies the whole session and ignores the checkpoint. The body must be `{before?: messageID}`. |
| B8  | Model list used `?directory=`.                                                                                                              | The parameter is silently ignored, so models resolve for the default location and workspace config is lost. Use `location[directory]`. |
| B9  | bb permission modes were not enforced.                                                                                                      | v2's `build` agent allows `*`, so `permission.asked` never fires. "accept-edits" never prompts.                                        |
| B10 | The "disable subagents" setting relied on rejecting permission requests.                                                                    | No permission request is ever made, so v2's native `subagent` tool runs freely.                                                        |
| B11 | Shell exit code was read from `data.exitCode`, which doesn't exist.                                                                         | A failed command shows exit 0. The real value is in `metadata.exit` on `session.tool.success` and `exit` on `shell.exited`.            |
| B12 | Settings dataDir split: the settings UI writes `~/.bb/plugins/opencode2/host-data/...`, but the bridge reads `bridge-data/...`.             | The allowlist, provider on/off, and subagent toggle never reach threads.                                                               |
| B13 | The default model was simply the first model sorted alphabetically.                                                                         | Wrong default. Use `/api/model/default`.                                                                                               |
| B14 | 162 of 471 models have no variants, but bb sent a fake variant "medium".                                                                    | OpenCode receives a variant that doesn't exist. The real default effort was also often `none`.                                         |

### Missing bb features

- Live command output. The plugin should stream shell output into bb's command rows.
- Accurate file-change rows. Edit tools return real patches, but the plugin
  ran `git diff` on the whole file, and every change showed as `update`.
- Context window: no `contextWindow` delta and `modelContextWindow: null`.
- Retry and backoff visibility: `session.retry.scheduled` is ignored.
- Native subagent delegation rows. bb has a `delegation` item with child
  `parentRef` keys.
- Plan mode. OpenCode has a built-in `plan` agent.
- Provider install and update, including version-floor health.
- Auth health. bb surfaces signInHint and loginCommand when a provider is unauthenticated.
- Turn diff (`turn.diff`) from the session diff endpoint.
- Event-stream recovery. Events are lost on disconnect (the docs say the
  stream is volatile), so active turns can hang forever.
- An offline conformance test with the SDK kit. There is no bridge
  conformance test yet.
- Native skill roots for bb's typeahead (optional).

### Genuinely unsupportable today (declare unsupported and document)

- Thread archive. Session.Info has `time.archived`, but PATCH only accepts
  title, metadata, and permissions.
- Thread goals. `thread/goal/clear` is a Codex concept.
- Service tiers.
- Provider usage dashboard. bb wants rate-limit windows; OpenCode only exposes
  cost totals (`/api/experimental/session/stats`).
- `instructionMode: "replace"`. Instruction entries are additive only.

## 2. Verified OpenCode 2.0.27 API facts

Sources: route table extracted from the binary (op id, path, and payload
keys), probes, and four recorded live turns. Docs: <https://opencode.ai/v2/docs/api>.

### Routes the plugin uses (correct forms)

- `POST /api/session` takes `{id?, parentID?, title?, agent?, model?, location?, metadata?, permissions?}`.
- `PATCH /api/session/:id` takes `{title?, metadata?, permissions?}`.
  `permissions` replaces the session ruleset.
- `DELETE /api/session/:id`.
- `GET /api/session/:id` returns `Session.Info`, including `outcome`
  (succeeded/failed/interrupted), `time.idle`, `tokens`, `cost`, and `model`.
- `GET /api/session/active` returns `{data: {<sessionID>: ...}}`.
  Use it for reconciliation.
- `POST /api/session/:id/prompt` takes `{id?, text, files?[{uri,name?}],
skills?[{id, mention}], metadata?, delivery?: "steer"|..., resume?}`.
  Unknown keys are stripped, and a valid prompt starts a model call.
- `POST /api/session/:id/fork` takes `{before?: messageID}`.
- `POST /api/session/:id/compact` takes `{id?, delivery?}`.
- `POST /api/session/:id/interrupt` (query `resume?`) returns `{interrupted}`.
- `POST /api/session/:id/revert/stage` takes `{messageID, files?}`.
  `POST .../revert/commit`. `DELETE .../revert` clears it.
- `POST /api/session/:id/agent` takes `{agent}`. `POST /api/session/:id/model` takes `{model:{providerID,id,variant?}}`.
- `PUT /api/session/:id/environment` takes `{variables: Record<string,string>}`.
- `PUT|DELETE /api/experimental/session/:id/instructions/entries/:key`, with `{value}` for PUT.
- `GET /api/session/:id/message?limit&order=asc|cursor=` returns `{data, cursor:{previous,next}}`.
  `next` is always present, so stop on an empty page. Message `type` is
  `user`, `assistant`, `idle` (with `outcome`), `compaction`, and others.
- `GET /api/session/:id/form`. `POST .../form/:formId/reply` takes `{answer: {<fieldKey>: string|number|boolean|string[]}}`.
  `DELETE .../form/:formId`.
- `POST /api/session/:id/permission/:requestID/reply` takes `{decision, message?}`.
- `GET /api/session/:id/diff?from=<userMsgId>&to=&context=` returns per-file
  `{file, patch, additions, deletions, status}`. It returned `[]` in tests,
  so verify when it populates.
- `PUT|DELETE /api/experimental/mcp/:server?location[directory]=`, with `{config}` for PUT.
- `GET /api/model?location[directory]=` returns
  `{providerID, id, name, variants[{id}], limit:{context,output},
capabilities:{input[]}, enabled, cost[], status}`.
  `GET /api/model/default` returns the same shape.
  Variant ids seen: none, minimal, low, medium, high, xhigh, max, thinking.
- `GET /api/agent?location[directory]=` lists agents: build (default), plan,
  general, explore, sophos, plus hidden compaction/title/summary agents.
- `GET /api/skill?location[directory]=` returns `[{id, name, description, ...}]`.
- `GET /api/integration` returns `connections[]`, where a status can be
  `needs_auth`.
- `GET /api/shell/:id/output?location[directory]=&cursor=<byte>&limit=` returns `{output, cursor, size, truncated}`.
- `GET /api/event` is SSE (`data: {type, data}`). It is volatile and does not
  replay. `GET /api/experimental/session/:id/log` has sequence IDs and may
  allow replay.

### Permission rules

Rules are `[{action, resource, effect: allow|deny|ask}]`. The agent ruleset
is evaluated first and then the session ruleset. The last match wins
(verified: a session rule of `*`→ask made `shell` ask under `build`).

Known actions: `*`, shell, read, edit (covers write/patch), grep, glob,
webfetch, websearch, question, subagent, external_directory, browser. Bare
reject behavior was verified: OpenCode then aborts the step and interrupts
execution with reason `shutdown`. Reject with `message` is untested; it should
feed back to the model.

`permission.asked` data looks like:
`{id:"per_…", sessionID, action:"shell", resources:["echo hello"], save:["echo *"], source:{type:"tool", messageID, id:<toolCallId>}}`.

### Events (recorded shapes)

- `session.inbox.enqueued` / `session.inbox.delivered {inboxID}`. The inboxID
  equals the prompt message ID. Use it to confirm steers.
- `session.execution.started|succeeded|failed{error}|interrupted{reason: user|shutdown|superseded|inactivity}`.
- `session.step.started {agent, model, assistantMessageID}`.
- `session.step.ended {finish, cost, tokens:{input,output,reasoning,cache:{read,write}}}`.
- `session.step.failed {error, tokens?}`.
- `session.usage.updated {cost, tokens}` carries cumulative session totals.
  Use it for `usage.total`.
- `session.retry.scheduled {assistantMessageID, attempt, at, error}`.
- `session.text|reasoning.started|delta|ended {assistantMessageID, ordinal, delta|text}`.
- `session.tool.input.started {id, name}`, `.input.ended {text}`,
  `session.tool.called {id, input}`, `session.tool.progress {id, metadata}`,
  `session.tool.success {id, content[], metadata}`, and
  `session.tool.failed {id, error:{type,message}}`.
- Tool names and inputs in v2:
  - `shell {command, timeout?}`
  - `read {path}`
  - `edit {path, oldString, newString}`
  - `write {path, content}`
  - `question {questions[{question, header, options[{label, description}]}]}`
  - `subagent {agent, description, prompt}`
  - There is no todo tool in v2.
- Shell flow: `session.tool.progress {metadata:{shellID}}`, then
  `shell.created {info:{id, command, cwd, file}}`, then `shell.exited {id, exit}`.
  Success metadata is `{status, exit}`, and the content has the output plus
  `"Exited with code N"`.
- Edit success metadata looks like:
  `{files:[{file, patch:<unified diff>, status:"modified"|"added"|"deleted", additions, deletions}]}`.
  Write metadata has no diff.
- Subagent flow: `session.tool.progress {metadata:{sessionID:<child>, status:"running"}}`.
  The result content looks like
  `<subagent sessionID=… state="completed">…</subagent>`. Child-session
  events carry the child's `sessionID`.
- `form.created {form:{id, sessionID, title, metadata:{kind:"question", tool:{messageID,id}}, fields:[{key:"q0", title, description, type:"string", options[{value,label,description}], custom:true}]}}`.
- `session.compaction.started{reason:auto|manual}`, `.delta`, and `.ended`
  (handled already).

## 3. Done

### Phase 1 (committed)

- SDK repinned to 0.6.37 as a runtime dependency.
- Fixed B1–B14 (see §1).
- Permission modes are now session rulesets. bb tools are allowed by their
  exact `<server>_<tool>` action names, because OpenCode doesn't glob
  actions.
- A deny sends a reject with a message. Verified live: the agent continues
  instead of the turn aborting.
- Settings travel through `deriveProviderOptions`. `model/list` and health
  read the host-data copy.
- Model catalog:
  - OpenCode's real default model.
  - Variant aliases (minimal→low, thinking→high).
  - No phantom variants are sent.
  - Each model's context limit is stored.
  - A cold location answers `[]` for about 400 ms, so the catalog retries
    and never caches an empty result.
- Plan mode: `composerActions: ["plan"]`, the `plan` agent is selected per
  turn, and the `/plan` mention is stripped from the prompt.
- MCP proxy: OpenCode v2 sends the session as
  `_meta["ai.opencode/sessionID"]`. Every bb dynamic tool call was being
  rejected before this fix.
- Shell exit codes come from `metadata.exit`, and a non-zero exit marks the
  row failed.
- Tests: `opencode-v2-contract.test.ts`, plus the updated old tests.
- Verified live, end to end:
  - model list
  - start (instructions honored, MCP registered)
  - accept-edits approval allow and deny
  - edit auto-allowed
  - exit code 4
  - bb dynamic tool round trip
  - rename
  - fork at checkpoint
  - discard with no MCP leak

### Phase 2 and 3 (committed, verified live unless noted)

- **Live command output.** Polls `/api/shell/:id/output` and streams it into
  bb's command row.
- **File changes from OpenCode's patches.** `metadata.files` drives the rows,
  with added/modified/deleted kinds. Writes fall back to git, untracked files
  show as added, and paths are made workspace-relative (including patch
  headers and symlinked cwds).
- **Usage and context window.** Uses the cumulative `session.usage.updated`
  totals and the last step's tokens, plus the model's context limit and a
  `contextWindow` delta.
- **Retries.** Scheduled retries show as `provider.error` with
  `willRetry: true`. Unit-tested only; I never triggered one live.
- **Turn reconciliation.** Runs after an event-stream reconnect and as a 30 s
  watchdog. Unit-tested only; a stream drop was not reproduced live.
- **Health, install, and update** (`host/maintenance.ts`).
- **bb dynamic tools** render as the bb tool with bb's presentation.
- **Plan mode.** `/plan` uses the `plan` agent, the mention is stripped, and
  the next turn switches back to `build`.
- **Native subagents as delegation rows.** Child-session events are nested
  through `parentRef`. When subagents are disabled, the deny rule hides the
  tool.
- **`turn.diff`.** Built from the turn's patches, because
  `/api/session/:id/diff` stays `[]` without snapshots.
- **Repeated tool results are ignored.**
- **Earlier work no longer ends a new turn.** Terminal execution events now
  wait for `session.inbox.delivered` of this turn's prompt. This fixed the
  turn after `/compact` ending instantly.
- **Settings page.** Per-host OpenCode status, collapsible provider groups,
  a default-model badge, and "Allow OpenCode subagents". A host RPC
  `getStatus` and a server RPC `getStatus` back it.
- **Docs.** README rewritten; added `skills/opencode2-provider/SKILL.md`.
- **Also verified live:** steering (`input.accepted`, steer honored), stop,
  in-place rewind (model forgets the dropped turns), `/compact` followed by a
  normal turn, rename, fork, discard with no MCP leak.
- **Plugin reloaded** in the user's bb. The `getStatus` and `listModels` RPCs
  were checked through the real server.

Dropped at the user's request: a fake OpenCode server fixture or SDK
conformance run against it. Coverage comes from unit tests plus the live
harness instead.

## 4. Remaining work (optional)

1. **Manual end-to-end check in the bb UI.** I haven't looked at any of this
   in bb's interface yet. The user should check: an approval prompt in
   accept-edits, the question tool's native UI, a delegation row, the live
   command output, and the new settings page. I didn't create bb threads
   myself, because the user didn't ask me to.
2. **Native skill roots.** `experimental_nativeSkillRoots` or
   `experimental_resolvesNativeRoots` backed by `GET /api/skill`, so bb's
   typeahead lists OpenCode skills.
3. **Diagnostics.** Forward unknown OpenCode events for an active session as
   `unhandled` deltas, rate-limited.
4. **Child-session questions.** A subagent's question closes without its
   `parentRef` (the question handler emits the close). This is cosmetic and
   rare.
5. **Replay test** (`BB_PROVIDER_BRIDGE_RECORD_DIR` and the parity kit), if
   regressions show up.

## 5. Decisions taken

- Native subagents stay disabled by default and are enforced with a session
  `deny` rule. When the user enables them, they render as bb delegation rows.
- `auto` mode keeps OpenCode's agent rules; bb auto-answers remaining asks
  with `once`. `full` mode adds `*`→allow, so nothing prompts.
- The OpenCode background service is shared and must never be stopped by the
  plugin.
- Scratch sessions created while probing must be deleted. The probe session
  `ses_ecee31b5…` was deleted. The recorder deletes its own sessions, but the
  run4 (question) session timed out, so confirm it's gone:
  `GET /api/session?title=…`, or list sessions in `/tmp/claude-501/ocrec/ws*`.

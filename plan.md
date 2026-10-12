# OpenCode v2 provider — stabilization and full bb feature plan

Status: **Phase 1 done and committed on `main`. Next: Phase 2.**
Last updated: 2026-10-12. Targets: bb 0.46.0 (Plugin SDK 0.6.37), OpenCode v2.0.27.

## 0. Resume checklist (read first)

1. Work on `main` and commit after each verified step (user preference; no
   branches).
2. Phase 1 is committed. Continue with §4 Phase 2, in order.
3. Live smoke harness: `/tmp/claude-501/smoke/harness.mjs` plays the bb
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

## 4. Remaining work

### Phase 2: full bb feature set

1. **Live shell output.**
   - On `session.tool.progress` with `metadata.shellID`, map
     shellID→toolCallId and poll
     `GET /api/shell/:id/output?location[directory]=<cwd>&cursor=<n>` every
     ~400 ms.
   - Emit `item.outputDelta {channel:"command", key: itemKey(callId,"tool")}`.
   - Stop on `shell.exited`, `session.tool.success/failed`, or turn end, and
     abort with `active.abortController`.
   - Bound each delta with `boundedTimelineText`.
2. **File-change rows from metadata.**
   - On edit/write success, use `metadata.files[]` patches when present:
     `kind` = add/update/delete from `status`, `diff` = patch.
   - For `write` with no metadata, fall back to `git diff`, and for an
     untracked file use `kind:"add"` with `newText`.
   - Drop the whole-file `git diff` as the primary path.
3. **Usage and context.**
   - Set `usage.total` from `session.usage.updated` (cumulative) and
     `usage.last` from `step.ended`/`step.failed` tokens.
   - Set `modelContextWindow` from `session.contextWindow`.
   - Emit `contextWindow {used: last input+cacheRead+cacheWrite+output, size, estimated:false, attach:"currentOrLast"}`.
   - Persist usage to the session registry as today.
4. **Retries and errors.**
   - `session.retry.scheduled` → `provider.error {message, willRetry:true, category?}`.
     Also check `providerErrorCategorySchema` for a rate-limit category.
   - `session.step.failed` → record usage and keep the error for the
     boundary.
   - `session.execution.interrupted` with reason `inactivity` or `shutdown`
     → `provider.warning`.
5. **Native subagents as delegation rows** (when "disable subagents" is off).
   - Change the `subagent` tool row to an item
     `{type:"delegation", childRef:<childSessionID>, label: description, background:false}`.
     Open it on `tool.progress` when `metadata.sessionID` appears, and close
     it with a summary from the result content.
   - Register child→parent in a `childSessions` map and route child-session
     events through the router with a `parentRef = childRef` on item keys and
     `turn.open`.
   - Child permission and question asks go to the parent bb thread.
   - Read the bb delegation docs/types (`deltaDelegationShapeSchema`,
     `parentRef`) before implementing.
6. **Turn diff.**
   - At turn end, `GET /api/session/:id/diff?from=<checkpointId>` and emit
     `turn.diff {diff: concatenated patches}` when non-empty.
   - Otherwise build it from the edit metadata collected during the turn.
7. **Plan mode.**
   - In server.ts, set `composerActions: ["plan"]` and `strings.planModeCopy`.
   - In the bridge, `ensureSessionAgent(session, options.promptMode === "plan" ? "plan" : (session.agent === "plan" ? "build" : undefined))`
     via `POST /api/session/:id/agent {agent}`.
   - Check how bb's plan command mention arrives in the input
     (`resolveProviderPlanCommand`) and whether it must be stripped from the
     prompt text (see `removeCommandMentionsFromPromptInput`).
8. **Health, install, and update.** Create a new `host/maintenance.ts`:
   - `not_installed` when the binary is missing or the provider is disabled.
   - `unsupported_version` below `MIN_OPENCODE_VERSION = "2.0.26"`.
   - `unauthenticated` with `loginCommand: "opencode2 auth login"` when the
     catalog has no models.
   - `unknown` with a message when the service fails to start.
   - `canUpdate` when `npmLatestVersion("@opencode/cli")` is greater than the
     installed version (cache it).
   - `provider/installation/status|run`:
     - Install uses `npmGlobalInstallCommand("@opencode/cli")`.
     - Update uses `{command:"opencode2", args:["upgrade"], displayCommand:"opencode2 upgrade"}`.
       That works for bun, npm, brew, or curl installs.
     - Verification uses `installationVerification`.
   - Set `maintenance.installation: true` in server.ts, and register the
     schemas in `PARAM_SCHEMAS`.
9. **Event-stream recovery.**
   - On SSE reconnect, and on `location.shutdown`/`global.disposed`, check
     every session with an active turn against `GET /api/session/active`.
   - If a session is no longer active, read `GET /api/session/:id` for
     `outcome` (or the last `idle` message) and `finish()` with the matching
     status.
   - Add a watchdog: if no events arrive for an active turn for N minutes,
     reconcile.
   - Optionally replay with `/api/experimental/session/:id/log`.
10. **Steer confirmation.** Optionally emit `input.accepted` on
    `session.inbox.delivered` instead of on the prompt POST.
11. **Dynamic tool presentation.**
    - Recognize calls to the bb MCP server (tool name prefixed with the
      server name) and render them with the `DynamicTool.presentation` bb
      supplied. Fall back to `experimental_toolPresentation`.
    - Strip the server prefix from the label.
12. **Native skill roots** (optional).
    - `experimental_nativeSkillRoots` for `~/.config/opencode/skills` and
      `.opencode/skills`, or `experimental_resolvesNativeRoots` backed by
      `GET /api/skill`, so bb typeahead lists OpenCode skills.
13. **Unknown events.** For an active session, forward them as `provider/raw`
    or `unhandled {vouchedTurn:false}` at a low rate, for diagnostics.

### Phase 3: tests, docs, release

1. **Fake OpenCode server fixture.** A Node HTTP server that implements the
   routes in §2 and replays scripted event sequences derived from the
   recordings.
   - Add an env override (for example `OPENCODE2_SERVER_URL` and
     `OPENCODE2_SERVER_PASSWORD`) that `OpenCodeServer.connect` honors
     instead of running `opencode2 service start`.
   - Add it to `env.passthrough` only if it's needed outside tests.
2. **Conformance.** Add `provider-bridge.conformance.test.ts` using
   `experimental_runBridgeConformance` with
   `experimental_captureBridgeJsonRpcOutput`, driven against the fake server.
   Also add a stream test that asserts the assembled rows (command with live
   output and exit code, fileChange from a patch, delegation, usage and
   context).
3. **Recorded replay** (optional). Run the bb daemon with
   `BB_PROVIDER_BRIDGE_RECORD_DIR`, commit the lanes, and add a parity test.
4. **README.** Rewrite the feature tables. Document permission-mode mapping,
   plan mode, install and update, the minimum OpenCode version, and the
   unsupported list in §1.
5. **Plugin skill.** Add `skills/opencode2-provider/SKILL.md`, as the
   plugin-authoring rules require, covering settings, constraints, and
   troubleshooting.
6. **Ship.** Run `bb plugin build`, then `bb plugin reload opencode2`, then a
   manual run in the bb UI covering every row of the feature table.

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

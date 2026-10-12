// Request and event shapes verified against a live OpenCode v2.0.27 service.
import assert from "node:assert/strict";
import test from "node:test";
import {
  forkBoundaryRetainingThrough,
  mapModel,
  modelCatalogEntry,
  permissionReplyBody,
  resolveModelVariant,
  sessionPermissionRules,
  sessionPermissionsRequest,
  sessionRenameRequest,
  shellExitCode,
} from "./test-host-api.js";

test("accept-edits asks for everything except reads, searches, and edits", () => {
  const rules = sessionPermissionRules({
    permissionMode: "accept-edits",
    disableSubagents: false,
  });
  assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "ask" });
  const effect = (action: string, resource = "*") =>
    // OpenCode evaluates rules in order and the last match wins.
    rules
      .filter(
        (rule) =>
          (rule.action === "*" || rule.action === action) &&
          (rule.resource === "*" || rule.resource === resource),
      )
      .at(-1)?.effect;
  assert.equal(effect("shell"), "ask");
  assert.equal(effect("webfetch"), "ask");
  assert.equal(effect("edit"), "allow");
  assert.equal(effect("read"), "allow");
  assert.equal(effect("read", "*.env"), "ask");
});

test("full mode allows everything and auto keeps OpenCode's agent rules", () => {
  assert.deepEqual(
    sessionPermissionRules({ permissionMode: "full", disableSubagents: false }),
    [{ action: "*", resource: "*", effect: "allow" }],
  );
  assert.deepEqual(
    sessionPermissionRules({ permissionMode: "auto", disableSubagents: false }),
    [],
  );
});

test("disabled subagents are denied last and BB's own tool server is allowed", () => {
  const rules = sessionPermissionRules({
    permissionMode: "accept-edits",
    disableSubagents: true,
    dynamicToolServer: "bb_opencode2_abc",
    dynamicToolNames: ["bb_echo"],
  });
  assert.deepEqual(rules.slice(-3), [
    { action: "bb_opencode2_abc_bb_echo", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "task", resource: "*", effect: "deny" },
  ]);
});

test("session updates use PATCH /api/session/:id", () => {
  assert.deepEqual(sessionRenameRequest("ses_1", "New title"), {
    path: "/api/session/ses_1",
    init: { method: "PATCH", body: JSON.stringify({ title: "New title" }) },
  });
  assert.deepEqual(sessionPermissionsRequest("ses_1", []), {
    path: "/api/session/ses_1",
    init: { method: "PATCH", body: JSON.stringify({ permissions: [] }) },
  });
});

test("permission replies send `decision`, with a message when rejecting", () => {
  assert.deepEqual(permissionReplyBody("once"), { decision: "once" });
  assert.deepEqual(permissionReplyBody("always"), { decision: "always" });
  const reject = permissionReplyBody("reject");
  assert.equal(reject.decision, "reject");
  assert.match(reject.message ?? "", /denied/);
});

test("fork bodies use `before`, never the stripped `boundary` key", () => {
  const messages = [
    { id: "msg_u1", type: "user" },
    { id: "msg_a1", type: "assistant" },
    { id: "msg_u2", type: "user" },
  ];
  assert.deepEqual(forkBoundaryRetainingThrough(messages, "msg_u1"), {
    before: "msg_u2",
  });
  assert.deepEqual(forkBoundaryRetainingThrough(messages, "msg_u2"), {});
});

const model = (variants: string[], context?: number) => ({
  providerID: "opencode",
  id: "test-model",
  name: "Test Model",
  variants: variants.map((id) => ({ id })),
  ...(context ? { limit: { context } } : {}),
});

test("maps OpenCode variants to BB reasoning levels, including aliases", () => {
  const entry = modelCatalogEntry(
    model(["thinking", "minimal", "none", "max"], 200_000),
  );
  assert.deepEqual(
    [...entry.variants],
    [
      ["none", "none"],
      ["low", "minimal"],
      ["high", "thinking"],
      ["max", "max"],
    ],
  );
  assert.equal(entry.contextWindow, 200_000);
  // A native level wins over an alias.
  assert.equal(
    modelCatalogEntry(model(["low", "minimal"])).variants.get("low"),
    "low",
  );
});

test("never sends a variant the model does not have", () => {
  const withVariants = modelCatalogEntry(model(["minimal", "high"]));
  const ref = { providerID: "opencode", id: "test-model" };
  assert.deepEqual(
    resolveModelVariant({ ...ref, variant: "low" }, withVariants),
    { ...ref, variant: "minimal" },
  );
  assert.deepEqual(
    resolveModelVariant({ ...ref, variant: "medium" }, withVariants),
    ref,
  );
  assert.deepEqual(
    resolveModelVariant(
      { ...ref, variant: "medium" },
      modelCatalogEntry(model([])),
    ),
    ref,
  );
});

test("defaults to medium effort and marks only the chosen default model", () => {
  const mapped = mapModel(model(["none", "low", "medium", "high"]), true);
  assert.equal(mapped.defaultReasoningEffort, "medium");
  assert.equal(mapped.isDefault, true);
  assert.equal(mapModel(model([]), false).isDefault, false);
  assert.deepEqual(mapModel(model([]), false).supportedReasoningEfforts, [
    { reasoningEffort: "medium", description: "Default" },
  ]);
});

test("reads shell exit codes from v2 tool metadata or content", () => {
  assert.equal(
    shellExitCode({ metadata: { status: "completed", exit: 3 } }),
    3,
  );
  assert.equal(
    shellExitCode({
      content: [
        { type: "text", text: "tick\n" },
        { type: "text", text: "Exited with code 2" },
      ],
    }),
    2,
  );
  assert.equal(shellExitCode({ metadata: { status: "completed" } }), undefined);
});

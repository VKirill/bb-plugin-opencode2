import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeEventRouter } from "./test-host-api.js";
import type { OpenCodeRecord, SessionState } from "./host/types.ts";

test("translates current OpenCode v2 text, reasoning, tool, and terminal events", async () => {
  const emitted: OpenCodeRecord[] = [];
  const active = {
    providerTurnId: "turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "oc-session",
    cwd: process.cwd(),
    disableSubagents: false,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
  };
  const sessionLookup = new Map([[session.providerThreadId, session]]);
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    sessionLookup,
  );
  const event = (type: string, data: OpenCodeRecord) =>
    router.handleEvent({
      type,
      data: { sessionID: session.providerThreadId, ...data },
    });

  await event("session.text.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
  });
  await event("session.text.delta", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    delta: "Hello",
  });
  await event("session.text.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    text: "Hello",
  });
  await event("session.text.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 1,
  });
  await event("session.text.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 1,
    text: "Again",
  });
  await event("session.reasoning.started", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    state: {},
  });
  await event("session.reasoning.delta", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    delta: "Think",
  });
  await event("session.reasoning.ended", {
    assistantMessageID: "msg-assistant",
    ordinal: 0,
    text: "Think",
    state: {},
  });
  await event("session.tool.input.started", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    name: "bash",
  });
  await event("session.tool.input.ended", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    text: JSON.stringify({ command: "printf ok" }),
  });
  await event("session.tool.called", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    input: { command: "printf ok" },
    executed: true,
    state: {},
  });
  await event("session.tool.success", {
    assistantMessageID: "msg-assistant",
    id: "tool-1",
    content: [{ type: "text", text: "ok" }],
    metadata: {},
  });
  await event("session.step.ended", {
    assistantMessageID: "msg-assistant",
    finish: "stop",
    tokens: {
      input: 3,
      output: 2,
      reasoning: 1,
      cache: { read: 4, write: 5 },
    },
  });
  // OpenCode follows each step with the session's cumulative totals.
  await event("session.usage.updated", {
    cost: 0,
    tokens: {
      input: 30,
      output: 20,
      reasoning: 10,
      cache: { read: 40, write: 50 },
    },
  });
  await event("session.execution.succeeded", {});

  const openedKeys = emitted
    .filter((delta) => delta.kind === "item.open")
    .map((delta) => delta.key as { providerItemId: string; channel: string });
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "text:msg-assistant:0" &&
        key.channel === "agentMessage",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "text:msg-assistant:1" &&
        key.channel === "agentMessage",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) =>
        key.providerItemId === "reasoning:msg-assistant:0" &&
        key.channel === "reasoningText",
    ),
  );
  assert.ok(
    openedKeys.some(
      (key) => key.providerItemId === "tool-1" && key.channel === "tool",
    ),
  );
  assert.equal(
    new Set(openedKeys.map((key) => JSON.stringify(key))).size,
    openedKeys.length,
  );

  const usage = emitted.find((delta) => delta.kind === "usage");
  assert.equal(usage?.last.totalTokens, 15);
  assert.equal(usage?.total.totalTokens, 150);
  assert.equal(usage?.modelContextWindow, 1000);
  const context = emitted.find((delta) => delta.kind === "contextWindow");
  assert.equal(context?.used, 15);
  assert.equal(context?.size, 1000);
  assert.equal(session.active, undefined);
  assert.equal(emitted.at(-1)?.kind, "turn.boundary");
  assert.equal(emitted.at(-1)?.status, "completed");
});

test("nests a native subagent's work under its delegation row", async () => {
  const emitted: OpenCodeRecord[] = [];
  const active = {
    providerTurnId: "turn-1",
    startedAt: Date.now(),
    abortController: new AbortController(),
    opened: new Map<string, OpenCodeRecord>(),
    pendingTools: new Map<string, string>(),
    pendingInput: new Map<string, string>(),
    touchedFiles: new Map<string, string[]>(),
    openQuestions: new Map<string, string>(),
    settledTools: new Set<string>(),
  };
  const session: SessionState = {
    bbThreadId: "bb-thread",
    providerThreadId: "ses_parent",
    cwd: process.cwd(),
    disableSubagents: false,
    dynamicTools: [],
    disallowedTools: new Set(),
    enabledModels: null,
    instructions: "",
    bridgeEnvVars: {},
    dynamicToolScope: {},
    active,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const router = new OpenCodeEventRouter(
    async () => ({}),
    (_threadId, deltas) => emitted.push(...deltas),
    new Map([[session.providerThreadId, session]]),
  );
  const event = (sessionID: string, type: string, data: OpenCodeRecord) =>
    router.handleEvent({ type, data: { sessionID, ...data } });

  await event("ses_parent", "session.tool.input.started", {
    id: "call_sub",
    name: "subagent",
  });
  await event("ses_parent", "session.tool.called", {
    id: "call_sub",
    input: { agent: "explore", description: "List files", prompt: "ls" },
  });
  await event("ses_parent", "session.tool.progress", {
    id: "call_sub",
    metadata: { sessionID: "ses_child", status: "running" },
  });
  await event("ses_child", "session.tool.input.started", {
    id: "call_child",
    name: "read",
  });
  await event("ses_child", "session.tool.called", {
    id: "call_child",
    input: { path: "package.json" },
  });
  await event("ses_child", "session.tool.success", {
    id: "call_child",
    content: [{ type: "text", text: "{}" }],
  });
  // The child's own lifecycle must not settle the parent turn.
  await event("ses_child", "session.execution.succeeded", {});
  assert.equal(session.active, active);
  await event("ses_parent", "session.tool.success", {
    id: "call_sub",
    content: [
      {
        type: "text",
        text: '<subagent sessionID="ses_child" state="completed">\nOne file.\n</subagent>',
      },
    ],
    metadata: { sessionID: "ses_child", status: "completed" },
  });

  const delegationOpen = emitted.find(
    (delta) => delta.kind === "item.open" && delta.item.type === "delegation",
  );
  assert.equal(delegationOpen?.item.label, "explore: List files");
  assert.equal(delegationOpen?.key.parentRef, undefined);
  const childRows = emitted.filter(
    (delta) => delta.key?.providerItemId === "call_child",
  );
  assert.equal(childRows.length, 2);
  for (const delta of childRows) assert.equal(delta.key.parentRef, "call_sub");
  const delegationClose = emitted.find(
    (delta) => delta.kind === "item.close" && delta.item.type === "delegation",
  );
  assert.equal(delegationClose?.status, "completed");
  assert.equal(delegationClose?.item.childRef, "ses_child");
  assert.equal(delegationClose?.item.summary, "One file.");

  // Child events after the delegation's turn ended are dropped.
  router.finish(session, "completed");
  const count = emitted.length;
  await event("ses_child", "session.text.started", {
    assistantMessageID: "m",
    ordinal: 0,
  });
  assert.equal(emitted.length, count);
});

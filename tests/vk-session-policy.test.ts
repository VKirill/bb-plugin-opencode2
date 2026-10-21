// VK required session policy: core's runtime policy becomes OpenCode session permission rules.
import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenCodeServer,
  experimental_providerBridge,
  ensureSessionPermissions,
  prepareTurn,
  readVkSessionPolicy,
  sessionFromParams,
  sessionPermissionRules,
  vkPolicyRules,
} from "./support/host-api.js";

const required = (policy: Record<string, unknown>) => ({
  vkRequiredSessionPolicy: 1,
  vkSessionPolicy: { version: 1, required: true, ...policy },
});

test("reads the policy core hands over, and nothing when there is none", () => {
  assert.equal(readVkSessionPolicy(undefined), null);
  assert.equal(readVkSessionPolicy({}), null);
  assert.equal(readVkSessionPolicy({ modelSettings: {} }), null);
  const policy = readVkSessionPolicy(
    required({
      bbSkillsDenied: ["bb-skill"],
      skills: { mode: "allow", names: ["alpha"] },
      mcpServers: { mode: "allow", names: ["bb-bridge"] },
    }),
  );
  assert.deepEqual(policy, {
    required: true,
    bbSkillsDenied: ["bb-skill"],
    skills: { mode: "allow", names: ["alpha"] },
    mcpServers: { mode: "allow", names: ["bb-bridge"] },
  });
  // An advisory policy is read without the required marker.
  assert.equal(
    readVkSessionPolicy({ vkSessionPolicy: { version: 1, bbSkillsDenied: [] } })
      ?.required,
    false,
  );
});

test("a required policy that is dropped or malformed is an error, not a silent no-op", () => {
  assert.throws(
    () => readVkSessionPolicy({ vkRequiredSessionPolicy: 1 }),
    /vk_required_session_policy_dropped/,
  );
  assert.throws(
    () => readVkSessionPolicy({ vkRequiredSessionPolicy: 2 }),
    /unsupported_version/,
  );
  assert.throws(
    () =>
      readVkSessionPolicy({
        vkRequiredSessionPolicy: 1,
        vkSessionPolicy: { version: 1, skills: { mode: "allow", names: [] } },
      }),
    /vk_required_session_policy_invalid/,
  );
  assert.throws(
    () =>
      readVkSessionPolicy(
        required({ skills: { mode: "maybe", names: ["alpha"] } }),
      ),
    /vk_required_session_policy_invalid/,
  );
  // A broken advisory policy is ignored, as core's own reader does.
  assert.equal(
    readVkSessionPolicy({ vkSessionPolicy: { version: 1, skills: 7 } }),
    null,
  );
});

test("skills: an allow list denies everything else, a deny list names what goes", () => {
  const allow = vkPolicyRules(
    readVkSessionPolicy(
      required({ skills: { mode: "allow", names: ["alpha", "lane:*"] } }),
    )!,
    {},
  );
  assert.deepEqual(allow, [
    { action: "skill", resource: "*", effect: "deny" },
    { action: "skill", resource: "alpha", effect: "allow" },
    { action: "skill", resource: "lane:*", effect: "allow" },
  ]);
  assert.deepEqual(
    vkPolicyRules(
      readVkSessionPolicy(required({ skills: { mode: "allow", names: [] } }))!,
      {},
    ),
    [{ action: "skill", resource: "*", effect: "deny" }],
  );
  assert.deepEqual(
    vkPolicyRules(
      readVkSessionPolicy(
        required({ skills: { mode: "deny", names: ["beta", "x:*"] } }),
      )!,
      {},
    ),
    [
      { action: "skill", resource: "beta", effect: "deny" },
      { action: "skill", resource: "x:*", effect: "deny" },
    ],
  );
});

test("skills: an allow list intersected with other clauses is resolved against discovered skills", () => {
  const policy = readVkSessionPolicy(
    required({
      skills: {
        mode: "allow",
        names: ["a*", "b"],
        allOf: [{ mode: "deny", names: ["ab"] }],
      },
    }),
  )!;
  assert.deepEqual(vkPolicyRules(policy, { skills: ["aa", "ab", "b", "c"] }), [
    { action: "skill", resource: "*", effect: "deny" },
    { action: "skill", resource: "aa", effect: "allow" },
    { action: "skill", resource: "b", effect: "allow" },
  ]);
  // Without the list a required policy cannot be enforced, so it fails.
  assert.throws(
    () => vkPolicyRules(policy, {}),
    /vk_required_session_policy_unenforceable_skills/,
  );
  // An advisory one skips the group instead.
  assert.deepEqual(vkPolicyRules({ ...policy, required: false }, {}), []);
});

test("BB skills core dropped stay denied even when OpenCode finds one with that name", () => {
  const rules = vkPolicyRules(
    readVkSessionPolicy(
      required({
        bbSkillsDenied: ["dropped"],
        skills: { mode: "allow", names: ["dropped", "kept"] },
      }),
    )!,
    {},
  );
  assert.deepEqual(rules.at(-1), {
    action: "skill",
    resource: "dropped",
    effect: "deny",
  });
});

test("MCP servers: every OpenCode server the filter does not admit is denied, BB's own proxies never", () => {
  const servers = ["agentmemory", "gitnexus", "bb_opencode2_0123", "metamcp"];
  const allow = vkPolicyRules(
    readVkSessionPolicy(
      required({
        mcpServers: { mode: "allow", names: ["bb-bridge", "gitnexus"] },
      }),
    )!,
    { mcpServers: servers },
  );
  assert.deepEqual(allow, [
    { action: "agentmemory_*", resource: "*", effect: "deny" },
    { action: "metamcp_*", resource: "*", effect: "deny" },
  ]);
  assert.deepEqual(
    vkPolicyRules(
      readVkSessionPolicy(
        required({ mcpServers: { mode: "deny", names: ["metamcp"] } }),
      )!,
      { mcpServers: servers },
    ),
    [{ action: "metamcp_*", resource: "*", effect: "deny" }],
  );
  assert.throws(
    () =>
      vkPolicyRules(
        readVkSessionPolicy(
          required({ mcpServers: { mode: "allow", names: [] } }),
        )!,
        {},
      ),
    /vk_required_session_policy_unenforceable_mcp_servers/,
  );
});

test("the default ruleset is unchanged, and policy rules come last so they beat the mode", () => {
  for (const permissionMode of ["accept-edits", "auto", "full", undefined]) {
    const base = {
      ...(permissionMode ? { permissionMode } : {}),
      disableSubagents: true,
      dynamicToolServer: "bb_opencode2_own",
      dynamicToolNames: ["tool"],
    };
    const plain = sessionPermissionRules(base);
    assert.deepEqual(
      sessionPermissionRules({ ...base, policyRules: [] }),
      plain,
    );
    assert.deepEqual(
      sessionPermissionRules({ ...base, policyRules: undefined }),
      plain,
    );
    const policyRules = [
      { action: "skill", resource: "*", effect: "deny" as const },
    ];
    const withPolicy = sessionPermissionRules({ ...base, policyRules });
    assert.deepEqual(withPolicy.slice(0, plain.length), plain);
    assert.deepEqual(withPolicy[plain.length], policyRules[0]);
    // This session's own BB tool server is restated after the policy rules.
    assert.deepEqual(withPolicy.at(-1), {
      action: "bb_opencode2_own_*",
      resource: "*",
      effect: "allow",
    });
  }
});

function fakeOpenCode(servers: string[], skills: string[]) {
  const sent: unknown[][] = [];
  const original = OpenCodeServer.prototype.request;
  OpenCodeServer.prototype.request = async function (
    path: string,
    init: RequestInit = {},
  ) {
    if (path.startsWith("/api/mcp"))
      return { data: servers.map((name) => ({ name })) };
    if (path.startsWith("/api/skill"))
      return { data: skills.map((name) => ({ id: name })) };
    if (init.method === "PATCH") {
      sent.push(JSON.parse(String(init.body)).permissions);
      return {};
    }
    return { data: [] };
  } as never;
  return {
    sent,
    restore: () => {
      OpenCodeServer.prototype.request = original;
    },
  };
}

function session(providerOptions: Record<string, unknown>, mode = "full") {
  return sessionFromParams(
    {
      threadId: "thr_policy",
      cwd: "/tmp/policy-project",
      options: { permissionMode: mode, providerOptions },
    },
    "ses_policy",
    {
      providerEnabled: true,
      enabledModels: null,
      disableSubagents: true,
    } as never,
  );
}

test("a session without a policy sends exactly the rules it always did", async () => {
  const fake = fakeOpenCode(["agentmemory"], ["alpha"]);
  try {
    const state = session({});
    await ensureSessionPermissions(state);
    assert.deepEqual(fake.sent, [
      sessionPermissionRules({
        permissionMode: "full",
        disableSubagents: true,
        dynamicToolServer: "bb_opencode2_x",
        dynamicToolNames: [],
      }),
    ]);
  } finally {
    fake.restore();
  }
});

test("a required policy is applied with the session, re-applied only when it changes, and follows each turn", async () => {
  const fake = fakeOpenCode(["agentmemory", "gitnexus"], ["alpha", "beta"]);
  try {
    const state = session(
      required({
        skills: { mode: "allow", names: ["alpha"] },
        mcpServers: { mode: "allow", names: ["bb-bridge"] },
      }),
    );
    await ensureSessionPermissions(state);
    await ensureSessionPermissions(state);
    assert.equal(fake.sent.length, 1, "an unchanged ruleset is not re-sent");
    const actions = (fake.sent[0] as { action: string }[]).map((r) => r.action);
    assert.deepEqual(actions.slice(-4), [
      "skill",
      "skill",
      "agentmemory_*",
      "gitnexus_*",
    ]);

    // The next turn carries a changed policy: gitnexus is now admitted.
    await prepareTurn(state, {
      permissionMode: "full",
      providerOptions: required({
        skills: { mode: "allow", names: ["alpha"] },
        mcpServers: { mode: "allow", names: ["bb-bridge", "gitnexus"] },
      }),
    });
    assert.equal(fake.sent.length, 2);
    assert.deepEqual(
      (fake.sent[1] as { action: string }[]).map((r) => r.action).slice(-3),
      ["skill", "skill", "agentmemory_*"],
    );

    // Policy removed: the plain ruleset returns.
    await prepareTurn(state, { permissionMode: "full", providerOptions: {} });
    assert.equal(fake.sent.length, 3);
    assert.ok(
      !(fake.sent[2] as { action: string }[]).some(
        (r) =>
          r.action === "skill" ||
          (r.action.endsWith("_*") && r.action !== "bb_opencode2_*"),
      ),
    );
  } finally {
    fake.restore();
  }
});

test("a required policy fails the session when OpenCode cannot list its MCP servers", async () => {
  const original = OpenCodeServer.prototype.request;
  OpenCodeServer.prototype.request = async function (path: string) {
    if (path.startsWith("/api/mcp")) throw new Error("boom");
    return {};
  } as never;
  try {
    await assert.rejects(
      ensureSessionPermissions(
        session(required({ mcpServers: { mode: "allow", names: [] } })),
      ),
      /unenforceable_mcp_servers/,
    );
  } finally {
    OpenCodeServer.prototype.request = original;
  }
});

test("the bridge declares that it enforces a required session policy", async () => {
  const written: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as never;
  try {
    experimental_providerBridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 2, client: { name: "bb", version: "0" } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.stdout.write = write;
  }
  const reply = JSON.parse(written.join("").trim().split("\n")[0]);
  assert.equal(
    reply.result.capabilities.experimental_vkRequiredSessionPolicy,
    1,
  );
});

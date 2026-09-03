import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ModelSettings } from "../settings-contract.ts";
import { dynamicToolCallRouter } from "./bridge-runtime.ts";
import {
  startDynamicToolsMcpProxy,
  type DynamicToolCallResult,
} from "./dynamic-tools-mcp.ts";
import {
  assertModelEnabled,
  modelRefFromOptions,
  modelSwitchRequest,
  sameModelRef,
} from "./models.ts";
import {
  dynamicMcpRegistrationRequest,
  dynamicMcpRemovalRequest,
  resolveBbBinDir,
  sessionEnvironmentRequest,
  sessionEnvironmentVariables,
  sessionInstructionsRequest,
} from "./opencode-requests.ts";
import { openCodeServer } from "./opencode-server.ts";
import { enabledDynamicTools, sameDynamicTools } from "./prompt.ts";
import {
  errorMessage,
  parsePermissionMode,
  stringValue,
  sessions,
  sessionsByProviderId,
  type ModelRef,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

function dynamicMcpServerName(providerThreadId: string) {
  return `bb_opencode2_${createHash("sha256").update(providerThreadId).digest("hex").slice(0, 20)}`;
}

export function sessionFromParams(
  params: RecordValue,
  providerThreadId: string,
  modelSettings: ModelSettings,
): SessionState {
  if (!modelSettings.providerEnabled) {
    throw new Error("OpenCode provider is disabled");
  }
  const disallowedTools = new Set(
    Array.isArray(params.disallowedTools)
      ? params.disallowedTools.filter(
          (tool): tool is string => typeof tool === "string",
        )
      : [],
  );
  const options =
    params.options && typeof params.options === "object"
      ? (params.options as RecordValue)
      : {};
  const bridgeEnvVars: Record<string, string> = {};
  if (
    options.envVars &&
    typeof options.envVars === "object" &&
    !Array.isArray(options.envVars)
  ) {
    for (const [key, value] of Object.entries(
      options.envVars as Record<string, unknown>,
    )) {
      if (typeof value === "string") bridgeEnvVars[key] = value;
    }
  }
  const enabledModels =
    modelSettings.enabledModels === null
      ? null
      : new Set(modelSettings.enabledModels);
  const model = modelRefFromOptions(options);
  assertModelEnabled(model, enabledModels);

  return {
    bbThreadId: String(params.threadId),
    providerThreadId,
    cwd: String(params.cwd),
    permissionMode: parsePermissionMode(options.permissionMode),
    // Preserve the existing policy backstop when a caller explicitly blocks
    // OpenCode's native subagent tools as well as when the plugin setting does.
    disableSubagents:
      modelSettings.disableSubagents !== false ||
      disallowedTools.has("task") ||
      disallowedTools.has("subagent"),
    dynamicTools: enabledDynamicTools(params.dynamicTools, disallowedTools),
    disallowedTools,
    enabledModels,
    instructions: stringValue(options.instructions) ?? "",
    bridgeEnvVars,
    dynamicToolScope: {},
    model,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function installDynamicTools(session: SessionState) {
  if (session.dynamicTools.length === 0) return;
  const proxy = await startDynamicToolsMcpProxy({
    serverName: dynamicMcpServerName(session.providerThreadId),
    sessionId: session.providerThreadId,
    tools: session.dynamicTools,
    entryPath: fileURLToPath(import.meta.url),
    callTool: async ({
      sessionId,
      toolName,
      arguments: toolArguments,
    }): Promise<DynamicToolCallResult> => {
      // Resolve the live session on every call so a reused proxy keeps
      // working after BB re-sends construction (resume) for the same thread.
      const current =
        sessionId !== undefined
          ? sessionsByProviderId.get(sessionId)
          : undefined;
      if (!current || current.bbThreadId !== session.bbThreadId) {
        return { content: "BB thread session not found", isError: true };
      }
      if (!current.active)
        return {
          content: "No active BB turn for this tool call",
          isError: true,
        };
      if (!current.dynamicTools.some((tool) => tool.name === toolName)) {
        return { content: `Tool "${toolName}" is disabled`, isError: true };
      }
      return dynamicToolCallRouter.forward({
        arguments: toolArguments,
        providerThreadId: current.providerThreadId,
        scope: current.dynamicToolScope,
        threadId: current.bbThreadId,
        toolName,
      });
    },
  });
  session.dynamicToolProxy = proxy;
  try {
    // `codemode: false` in the proxy config exposes each BB tool directly.
    const request = dynamicMcpRegistrationRequest(
      proxy.serverName,
      session.cwd,
      proxy.config,
    );
    await openCodeServer.request(request.path, request.init);
    await openCodeServer.rememberMcpRegistration(session.providerThreadId, {
      serverName: proxy.serverName,
      cwd: session.cwd,
    });
  } catch (error) {
    proxy.close();
    session.dynamicToolProxy = undefined;
    throw error;
  }
}

export async function releaseDynamicTools(
  session: SessionState,
  reason: string,
) {
  dynamicToolCallRouter.resolve(session.dynamicToolScope, reason);
  const proxy = session.dynamicToolProxy;
  if (!proxy) return;
  session.dynamicToolProxy = undefined;
  proxy.close();
  const request = dynamicMcpRemovalRequest(proxy.serverName, session.cwd);
  try {
    await openCodeServer.request(request.path, request.init);
    await openCodeServer.forgetMcpRegistration(session.providerThreadId);
  } catch {
    // Keep the registry entry so a later discard can retry the removal.
  }
}

async function installSessionInstructions(session: SessionState) {
  const request = sessionInstructionsRequest(
    session.providerThreadId,
    session.instructions,
  );
  // Do not delete on empty input: a newly-created session has no provider
  // entry, and the documented endpoint reports that absence as a 404.
  if (!request) return;
  await openCodeServer.request(request.path, request.init);
}

async function installSessionEnvironment(session: SessionState) {
  // Best-effort: a session without the BB environment still runs, it just
  // lacks `bb` on PATH for its shells. Never fail session setup for this.
  try {
    const variables = sessionEnvironmentVariables({
      hostEnv: process.env,
      bridgeEnvVars: session.bridgeEnvVars,
      bbBinDir: await resolveBbBinDir(),
    });
    const request = sessionEnvironmentRequest(
      session.providerThreadId,
      variables,
    );
    await openCodeServer.request(request.path, request.init);
  } catch (error) {
    process.stderr.write(
      `[opencode2] Could not set OpenCode session environment: ${errorMessage(error)}\n`,
    );
  }
}

export async function registerSession(session: SessionState) {
  const previous = sessions.get(session.bbThreadId);
  const reusableProxy =
    previous &&
    previous.providerThreadId === session.providerThreadId &&
    previous.dynamicToolProxy &&
    sameDynamicTools(previous.dynamicTools, session.dynamicTools)
      ? previous.dynamicToolProxy
      : undefined;
  if (previous) {
    previous.active?.abortController.abort();
    if (reusableProxy) {
      // Same OpenCode session and tool catalog: keep the live MCP child
      // instead of re-registering (which respawns it per message). Settle
      // calls started under the previous scope; the proxy serves the new
      // session object through live lookup.
      dynamicToolCallRouter.resolve(
        previous.dynamicToolScope,
        "The BB thread session was replaced",
      );
    } else {
      await releaseDynamicTools(previous, "The BB thread session was replaced");
    }
    sessionsByProviderId.delete(previous.providerThreadId);
  }
  sessions.set(session.bbThreadId, session);
  sessionsByProviderId.set(session.providerThreadId, session);
  if (reusableProxy) session.dynamicToolProxy = reusableProxy;
  try {
    await installSessionInstructions(session);
    if (!reusableProxy) await installDynamicTools(session);
  } catch (error) {
    sessions.delete(session.bbThreadId);
    sessionsByProviderId.delete(session.providerThreadId);
    await releaseDynamicTools(session, "OpenCode session setup failed");
    throw error;
  }
  await installSessionEnvironment(session);
}

export async function unregisterSession(
  session: SessionState,
  reason: string,
): Promise<void> {
  if (sessions.get(session.bbThreadId) === session) {
    sessions.delete(session.bbThreadId);
  }
  if (sessionsByProviderId.get(session.providerThreadId) === session) {
    sessionsByProviderId.delete(session.providerThreadId);
  }
  session.active?.abortController.abort();
  await releaseDynamicTools(session, reason);
}

export async function ensureSessionModel(
  session: SessionState,
  desired?: ModelRef,
  force = false,
) {
  if (!desired) return;
  assertModelEnabled(desired, session.enabledModels);
  if (!force && sameModelRef(session.model, desired)) return;
  const request = modelSwitchRequest(session.providerThreadId, desired);
  await openCodeServer.request(request.path, request.init);
  session.model = desired;
}

export async function shutdownSessions(reason: string): Promise<void> {
  const currentSessions = [...sessions.values()];
  sessions.clear();
  sessionsByProviderId.clear();

  const removals = currentSessions.flatMap((session) => {
    session.active?.abortController.abort();
    dynamicToolCallRouter.resolve(session.dynamicToolScope, reason);
    const proxy = session.dynamicToolProxy;
    if (!proxy) return [];
    session.dynamicToolProxy = undefined;
    proxy.close();
    const request = dynamicMcpRemovalRequest(proxy.serverName, session.cwd);
    return [
      {
        providerThreadId: session.providerThreadId,
        request,
      },
    ];
  });

  const results = await Promise.allSettled(
    removals.map(async ({ providerThreadId, request }) => {
      await openCodeServer.request(request.path, {
        ...request.init,
        signal: AbortSignal.timeout(2_000),
      });
      return providerThreadId;
    }),
  );
  const removedIds = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (removedIds.length > 0) {
    await openCodeServer.forgetMcpRegistrations(removedIds);
  }
}

import { delimiter, dirname } from "node:path";
import {
  experimental_resolveExecutablePath as resolveExecutablePath,
  sanitizeInheritedChildProcessEnv,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { OpenCodeRecord } from "./types.ts";

type RecordValue = OpenCodeRecord;

const BB_INSTRUCTIONS_ENTRY = "bb.provider.instructions";

/**
 * OpenCode beta registers a local MCP server at this exact resource. The
 * location query is a deep-object query parameter, not a legacy `directory`
 * string query parameter.
 */
export function dynamicMcpRegistrationRequest(
  serverName: string,
  cwd: string,
  config: RecordValue,
) {
  return {
    path: `/api/mcp/${encodeURIComponent(serverName)}?location[directory]=${encodeURIComponent(cwd)}`,
    init: { method: "PUT", body: JSON.stringify({ config }) },
  };
}

export function dynamicMcpRemovalRequest(serverName: string, cwd: string) {
  return {
    path: `/api/mcp/${encodeURIComponent(serverName)}?location[directory]=${encodeURIComponent(cwd)}`,
    init: { method: "DELETE" },
  };
}

/**
 * Session instruction entries are the documented beta mechanism for BB
 * instructions. The endpoint has no append/replace selector, so a BB
 * `replace` mode cannot be represented exactly.
 */
export function sessionInstructionsRequest(
  sessionId: string,
  instructions: string,
) {
  if (!instructions) return undefined;
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}/instructions/entries/${BB_INSTRUCTIONS_ENTRY}`,
    init: { method: "PUT", body: JSON.stringify({ value: instructions }) },
  };
}

/**
 * BB-spawned agents (e.g. Codex via its bridge child process) inherit the
 * host PATH, which BB augments with its own binary directory, so `bb` works
 * in their shells. OpenCode shells run under the shared background service
 * instead, whose environment is fixed at service start and may predate BB.
 * The session environment endpoint replaces the shell environment. Each
 * session therefore receives a credential-filtered host environment, BB's
 * explicit per-session envVars, and a PATH that includes `bb`.
 */
const SENSITIVE_ENVIRONMENT_KEY =
  /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PRIVATE_?KEY|PASSWORD|SECRET|TOKEN)(?:$|_)/i;
const SENSITIVE_ENVIRONMENT_PREFIX = /^(?:AWS|AZURE|GCP|GOOGLE|OPENCODE)_/i;

export function isSensitiveEnvironmentKey(key: string): boolean {
  return (
    SENSITIVE_ENVIRONMENT_KEY.test(key) ||
    SENSITIVE_ENVIRONMENT_PREFIX.test(key)
  );
}

export function sessionEnvironmentVariables(input: {
  hostEnv: NodeJS.ProcessEnv;
  bridgeEnvVars?: Record<string, string>;
  bbBinDir?: string;
}): Record<string, string> {
  const base = withoutBridgeRuntimeEnv(
    sanitizeInheritedChildProcessEnv({ env: input.hostEnv }),
  );
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string" && !isSensitiveEnvironmentKey(key)) {
      variables[key] = value;
    }
  }
  // BB passes these values explicitly for this provider session, so they are
  // trusted configuration rather than incidental host-process credentials.
  for (const [key, value] of Object.entries(input.bridgeEnvVars ?? {})) {
    if (typeof value === "string") variables[key] = value;
  }
  if (input.bbBinDir) {
    const entries = (variables.PATH ?? "")
      .split(delimiter)
      .filter((entry) => entry.length > 0);
    if (!entries.includes(input.bbBinDir)) entries.unshift(input.bbBinDir);
    variables.PATH = entries.join(delimiter);
  }
  return variables;
}

export function sessionEnvironmentRequest(
  sessionId: string,
  variables: Record<string, string>,
) {
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}/environment`,
    init: { method: "PUT", body: JSON.stringify({ variables }) },
  };
}

export async function resolveBbBinDir(): Promise<string | undefined> {
  try {
    const executable = await resolveExecutablePath("bb");
    return executable ? dirname(executable) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * BB rewind retains *through* a provider checkpoint, while OpenCode's fork
 * and revert APIs take a *before* boundary (exclude the given message).
 * Checkpoints are user message IDs, and a turn is user + following assistant
 * messages. To retain through checkpoint C, fork/revert before the next *user*
 * message after C. When C is already the last user turn, forking through the
 * tip (or no revert) keeps everything.
 */
export type CheckpointMessage = { id: string; type?: string };

function messageIdList(
  messages: readonly CheckpointMessage[] | readonly string[],
): string[] {
  return messages.map((entry) =>
    typeof entry === "string" ? entry : entry.id,
  );
}

export function nextMessageIdAfterCheckpoint(
  messages: readonly CheckpointMessage[] | readonly string[],
  checkpointId: string,
): string | undefined {
  const ids = messageIdList(messages);
  const types =
    Array.isArray(messages) &&
    messages.length > 0 &&
    typeof messages[0] !== "string"
      ? (messages as readonly CheckpointMessage[]).map((entry) => entry.type)
      : undefined;
  const index = ids.indexOf(checkpointId);
  if (index === -1) return undefined;
  // When types are known and the checkpoint is a user message, skip to the
  // next user message so the retained turn keeps its assistant reply.
  if (types) {
    for (let i = index + 1; i < ids.length; i++) {
      if (types[i] === "user") return ids[i];
    }
    return undefined;
  }
  return index + 1 < ids.length ? ids[index + 1] : undefined;
}

export function forkBoundaryRetainingThrough(
  messages: readonly CheckpointMessage[] | readonly string[],
  checkpointId?: string,
) {
  if (!checkpointId) return { type: "through" } as const;
  const ids = messageIdList(messages);
  const next = nextMessageIdAfterCheckpoint(messages, checkpointId);
  // Unknown checkpoint: fall back to a before-boundary on the given ID so
  // OpenCode surfaces MessageNotFound instead of silently forking the tip.
  if (next === undefined && !ids.includes(checkpointId)) {
    return { type: "before", messageID: checkpointId } as const;
  }
  if (next === undefined) return { type: "through" } as const;
  return { type: "before", messageID: next } as const;
}

export function steerAcceptedDelta(
  clientRequestId: string,
  providerTurnId: string,
): RecordValue {
  return { kind: "input.accepted", clientRequestId, providerTurnId };
}

export function revertTargetRetainingThrough(
  messages: readonly CheckpointMessage[] | readonly string[],
  checkpointId: string,
): string | undefined {
  const ids = messageIdList(messages);
  const next = nextMessageIdAfterCheckpoint(messages, checkpointId);
  // Unknown checkpoint: fall back to the given ID (before-semantics) so the
  // server error is explicit. Tip checkpoint: nothing to truncate.
  if (next === undefined) {
    return ids.includes(checkpointId) ? undefined : checkpointId;
  }
  return next;
}

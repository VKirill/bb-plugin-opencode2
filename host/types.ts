import type { DynamicTool } from "@get-bb/plugin-sdk/provider-bridge";
import type { DynamicToolsMcpProxy } from "./dynamic-tools-mcp.ts";

/**
 * OpenCode's beta API does not publish a complete event schema. Keep its
 * untyped payloads behind this adapter type and normalize fields before they
 * reach BB protocol objects.
 */
export type OpenCodeRecord = Record<string, any>;

export type OpenCodePermissionMode = "accept-edits" | "auto" | "full";
export type OpenCodePermissionReply = "once" | "always" | "reject";

export type ModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

export type ActiveTurn = {
  providerTurnId: string;
  abortController: AbortController;
  manualCompaction?: { itemId: string };
  checkpointId?: string;
  opened: Map<string, OpenCodeRecord>;
  pendingTools: Map<string, string>;
  pendingInput: Map<string, string>;
  touchedFiles: Map<string, string[]>;
  openQuestions: Map<string, string>;
  settledTools: Set<string>;
};

export type SessionState = {
  bbThreadId: string;
  providerThreadId: string;
  cwd: string;
  permissionMode?: OpenCodePermissionMode;
  disableSubagents: boolean;
  nativeSkillNames?: Set<string>;
  dynamicTools: DynamicTool[];
  disallowedTools: Set<string>;
  enabledModels: ReadonlySet<string> | null;
  instructions: string;
  bridgeEnvVars: Record<string, string>;
  dynamicToolScope: object;
  dynamicToolProxy?: DynamicToolsMcpProxy;
  active?: ActiveTurn;
  model?: ModelRef;
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export const sessions = new Map<string, SessionState>();
export const sessionsByProviderId = new Map<string, SessionState>();

export function isSubagentTool(name: string): boolean {
  const tool = name.toLowerCase();
  return tool === "task" || tool === "subagent";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parsePermissionMode(
  value: unknown,
): OpenCodePermissionMode | undefined {
  const mode = stringValue(value);
  return mode === "accept-edits" || mode === "auto" || mode === "full"
    ? mode
    : undefined;
}

export function inputRecord(value: unknown): OpenCodeRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as OpenCodeRecord)
    : {};
}

export function firstInputString(
  input: OpenCodeRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

export function parseInputText(text: unknown): OpenCodeRecord {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return inputRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

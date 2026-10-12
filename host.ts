import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  modelSummarySchema,
  opencodeHostContract,
} from "./settings-contract.ts";
import { openCodeServer } from "./host/opencode-server.ts";
import { shutdownBridge } from "./host/provider-bridge.ts";
import { sessions } from "./host/types.ts";

export { createDynamicToolCallRouter } from "./host/bridge-runtime.ts";
export {
  DYNAMIC_TOOLS_MCP_ARG,
  handleDynamicToolsMcpRequest,
  startDynamicToolsMcpProxy,
} from "./host/dynamic-tools-mcp.ts";
export {
  assertModelEnabled,
  mapModel,
  modelCatalogEntry,
  resolveModelVariant,
  modelRefFromOptions,
  modelSwitchRequest,
  sameModelRef,
  turnModelRef,
} from "./host/models.ts";
export {
  OpenCodeServer,
  parseOpenCodeServiceUrl,
} from "./host/opencode-server.ts";
export {
  OpenCodeEventRouter,
  shellExitCode,
  usageDeltas,
} from "./host/opencode-event-router.ts";
export {
  dynamicMcpRegistrationRequest,
  dynamicMcpRemovalRequest,
  forkBoundaryRetainingThrough,
  isSensitiveEnvironmentKey,
  nextMessageIdAfterCheckpoint,
  revertTargetRetainingThrough,
  sessionEnvironmentRequest,
  sessionEnvironmentVariables,
  sessionInstructionsRequest,
  sessionPermissionRules,
  sessionPermissionsRequest,
  sessionRenameRequest,
  steerAcceptedDelta,
} from "./host/opencode-requests.ts";
export {
  approvalPermissionReply,
  automaticPermissionReply,
  enabledDynamicTools,
  permissionReplyBody,
  promptBody,
  sameDynamicTools,
  SUBAGENT_DISABLED_TOOL_ERROR,
  subagentDisabledToolError,
  toolFailureError,
} from "./host/prompt.ts";
export { experimental_providerBridge } from "./host/provider-bridge.ts";
export { sessionFromParams } from "./host/session-manager.ts";
export { sessions } from "./host/types.ts";
export {
  boundedTimelineDelta,
  boundedTimelineText,
  isManualCompactionTurn,
  itemKeyForOpenItem,
  manualCompactionOutcomeDeltas,
  manualCompactionRequest,
  manualCompactionStartDeltas,
  MAX_TIMELINE_DELTA_BYTES,
  providerFailureDeltas,
  timelineDeltasForEmission,
} from "./host/timeline.ts";
export {
  metadataFileChanges,
  toolRow,
  touchedPaths,
  workspacePath,
} from "./host/tool-mapping.ts";

export default experimental_defineHostEntry({
  contract: opencodeHostContract,
  handlers: {
    async listModels(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      const catalog = await openCodeServer.modelCatalog(
        input.cwd ?? process.cwd(),
        true,
      );
      return {
        models: catalog.models.map((model) => {
          const id = `${model.providerID}/${model.id}`;
          return modelSummarySchema.parse({
            id,
            providerId: model.providerID,
            displayName: typeof model.name === "string" ? model.name : id,
          });
        }),
      };
    },
    async setModelSettings(input, context) {
      openCodeServer.setDataDir(context.experimental_paths.dataDir);
      await openCodeServer.writeModelSettings(input);
      for (const session of sessions.values()) {
        session.disableSubagents = input.disableSubagents !== false;
        session.enabledModels =
          input.enabledModels === null ? null : new Set(input.enabledModels);
      }
      return { ok: true as const };
    },
  },
  dispose: async () => {
    await shutdownBridge("OpenCode host worker disposed");
  },
});

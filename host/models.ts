import {
  inputRecord,
  stringValue,
  type ModelRef,
  type OpenCodeRecord,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

function parseModel(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  const hash = value.indexOf("#", slash + 1);
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1, hash === -1 ? undefined : hash),
    ...(hash === -1 ? {} : { variant: value.slice(hash + 1) }),
  };
}

/**
 * BB sends the selected model as `options.model` (`provider/model[#variant]`)
 * and the selected reasoning effort as `options.reasoningLevel` (`low`,
 * `high`, ...). OpenCode has no separate reasoning field: reasoning effort is
 * a named model variant (`provider/model#variant`). Combine both BB fields
 * into a single OpenCode `Model.Ref` so the effort picker actually reaches
 * the OpenCode thread. An explicit `reasoningLevel` wins over a `#variant`
 * suffix because it reflects the current picker state.
 */
export function modelRefFromOptions(options: unknown): ModelRef | undefined {
  const opts = inputRecord(options);
  const parsed = parseModel(opts.model);
  if (!parsed || !parsed.providerID || !parsed.id) return undefined;
  const level = stringValue(opts.reasoningLevel);
  const variant = level || parsed.variant;
  return {
    providerID: parsed.providerID,
    id: parsed.id,
    ...(variant ? { variant } : {}),
  };
}

/**
 * `POST /api/session/{id}/model` switches the model used by subsequent turns.
 * The prompt endpoint itself accepts no model, so per-turn model or reasoning
 * changes must go through this endpoint before prompting.
 */
export function modelId(model: ModelRef): string {
  return `${model.providerID}/${model.id}`;
}

export function assertModelEnabled(
  model: ModelRef | undefined,
  enabledModels: ReadonlySet<string> | null,
): void {
  if (model && enabledModels !== null && !enabledModels.has(modelId(model))) {
    throw new Error(`OpenCode model is disabled: ${modelId(model)}`);
  }
}

export function modelSwitchRequest(sessionId: string, model: ModelRef) {
  return {
    path: `/api/session/${encodeURIComponent(sessionId)}/model`,
    init: { method: "POST", body: JSON.stringify({ model }) },
  };
}

export function sameModelRef(
  a: ModelRef | undefined,
  b: ModelRef | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.providerID === b.providerID &&
    a.id === b.id &&
    (a.variant ?? undefined) === (b.variant ?? undefined)
  );
}

/**
 * Resolve the model ref for a turn: a full `options.model` wins, otherwise a
 * lone `reasoningLevel` reuses the session's stored base model with the new
 * variant so mid-thread effort changes still reach OpenCode.
 */
export function turnModelRef(
  session: { model?: { providerID: string; id: string; variant?: string } },
  options: unknown,
): ModelRef | undefined {
  const direct = modelRefFromOptions(options);
  if (direct) return direct;
  const opts = inputRecord(options);
  const level = stringValue(opts.reasoningLevel);
  if (level && session.model) {
    return {
      providerID: session.model.providerID,
      id: session.model.id,
      variant: level,
    };
  }
  return undefined;
}

export function mapModel(model: RecordValue, index: number) {
  const providerId = stringValue(model.providerID) ?? "unknown";
  const modelName = stringValue(model.id) ?? "unknown";
  const ref = `${providerId}/${modelName}`;
  const variants = Array.isArray(model.variants) ? model.variants : [];
  const levels = variants.flatMap((value: unknown) => {
    const variant = inputRecord(value);
    const variantId = stringValue(variant.id);
    const level = [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ].includes(variantId ?? "")
      ? variantId
      : undefined;
    return level ? [{ reasoningEffort: level, description: level }] : [];
  });
  return {
    id: ref,
    model: ref,
    displayName: stringValue(model.name) ?? ref,
    routeProviderId: providerId,
    description: `OpenCode provider ${providerId}`,
    supportedReasoningEfforts: levels.length
      ? levels
      : [{ reasoningEffort: "medium", description: "Default" }],
    defaultReasoningEffort: levels[0]?.reasoningEffort ?? "medium",
    isDefault: index === 0,
  };
}

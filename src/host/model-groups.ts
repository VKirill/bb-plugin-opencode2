import { isFreeModel } from "../free-models.ts";
import { stringValue, type OpenCodeRecord } from "./types.ts";

/** Subgroup of an aggregator's free models in the model picker. */
export const FREE_MODELS_GROUP = "🎁 Бесплатные";

const VENDOR_NAMES: Record<string, string> = {
  ai21: "AI21",
  amazon: "Amazon",
  anthropic: "Anthropic",
  "bytedance-seed": "ByteDance Seed",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  "deepseek-ai": "DeepSeek",
  google: "Google",
  "ibm-granite": "IBM Granite",
  meta: "Meta",
  "meta-llama": "Meta",
  microsoft: "Microsoft",
  minimax: "MiniMax",
  minimaxai: "MiniMax",
  inclusionai: "inclusionAI",
  mistralai: "Mistral",
  moonshotai: "Moonshot AI",
  nousresearch: "Nous Research",
  "nex-agi": "Nex AGI",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  perplexity: "Perplexity",
  "prism-ml": "Prism ML",
  qwen: "Qwen",
  rekaai: "Reka AI",
  sao10k: "Sao10K",
  stepfun: "StepFun",
  thedrummer: "TheDrummer",
  thinkingmachines: "Thinking Machines",
  "x-ai": "xAI",
  xiaomi: "Xiaomi",
  "z-ai": "Z.AI",
  "zai-org": "Z.AI",
};

/** `anthropic/claude-x` and `~anthropic/claude-latest` → "Anthropic". */
export function vendorName(modelId: string): string | undefined {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return undefined;
  const key = modelId.slice(0, slash).replace(/^~/, "").toLowerCase();
  if (!key) return undefined;
  return (
    VENDOR_NAMES[key] ??
    key
      .split(/[-_]/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/**
 * The picker subgroup of each model, keyed `provider/model`, for providers
 * that resell several vendors (OpenRouter): free models together, then one
 * subgroup per vendor with at least two models. A vendor with a single model
 * gets none, so it lands in the picker's closing "Other" subgroup. Providers
 * with fewer than two such subgroups stay flat.
 */
export function modelSubgroups(
  models: readonly OpenCodeRecord[],
): Map<string, string> {
  const byProvider = new Map<string, Map<string, string | undefined>>();
  for (const model of models) {
    const providerId = stringValue(model.providerID);
    const id = stringValue(model.id);
    if (!providerId || !id) continue;
    const entries = byProvider.get(providerId) ?? new Map();
    entries.set(
      id,
      isFreeModel(`${providerId}/${id}`) ? FREE_MODELS_GROUP : vendorName(id),
    );
    byProvider.set(providerId, entries);
  }
  const result = new Map<string, string>();
  for (const [providerId, entries] of byProvider) {
    const counts = new Map<string, number>();
    for (const group of entries.values())
      if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
    const kept = new Set(
      [...counts].filter(([, count]) => count >= 2).map(([group]) => group),
    );
    if (kept.size < 2) continue;
    for (const [id, group] of entries)
      if (group && kept.has(group)) result.set(`${providerId}/${id}`, group);
  }
  return result;
}

/** Free subgroup first, then vendors A–Z, then models without a subgroup. */
export function compareSubgroups(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (left === FREE_MODELS_GROUP) return -1;
  if (right === FREE_MODELS_GROUP) return 1;
  return left.localeCompare(right);
}

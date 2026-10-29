/** Marks free models in the BB model picker and the settings page. */
export const FREE_MODEL_MARK = "🎁";

/**
 * Free models by ID: OpenRouter's `:free` variants and its `free` router,
 * OpenCode Zen's `-free` models.
 */
export function isFreeModel(modelId: string): boolean {
  return /(?:^|[:/-])free$/i.test(modelId);
}

/**
 * "🎁 Name" for a free model. The trailing "(free)" / "Free" goes away since
 * the mark says the same; the model ID keeps `free` searchable.
 */
export function freeModelName(name: string): string {
  return `${FREE_MODEL_MARK} ${withoutFreeSuffix(name)}`;
}

/** "North Mini Code (free)" → "North Mini Code". */
export function withoutFreeSuffix(name: string): string {
  return name.replace(/\s+(?:\(free\)|free)\s*$/i, "").trim() || name;
}

/** Free models first, then by ID. */
export function compareFreeFirst(leftId: string, rightId: string): number {
  return (
    Number(isFreeModel(rightId)) - Number(isFreeModel(leftId)) ||
    leftId.localeCompare(rightId)
  );
}

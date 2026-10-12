import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSettings,
} from "./model-settings.ts";

test("normalizes legacy and malformed model settings", () => {
  assert.deepEqual(normalizeModelSettings(undefined), DEFAULT_MODEL_SETTINGS);
  assert.deepEqual(
    normalizeModelSettings({
      providerEnabled: false,
      enabledModels: ["openai/gpt-5", "openai/gpt-5", ""],
    }),
    {
      providerEnabled: false,
      enabledModels: ["openai/gpt-5"],
      disableSubagents: true,
      hideBbToolsOutsideBb: true,
    },
  );
});

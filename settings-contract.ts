import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const modelSummarySchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();

export const modelSettingsSchema = z
  .object({
    providerEnabled: z.boolean(),
    // null means every discovered model is enabled. An array is the exact
    // allowlist, including an empty array for "disable all".
    enabledModels: z.array(z.string().min(1)).max(10_000).nullable(),
    // Prevent OpenCode from starting native subagents (task tool) so agents
    // use BB for delegation instead. Missing key defaults to true so older
    // stored settings migrate to the safer default.
    disableSubagents: z.boolean().default(true),
  })
  .strict();

export const opencodeHostContract = defineRpcContract({
  listModels: {
    input: z.object({ cwd: z.string().min(1).optional() }).strict(),
    output: z
      .object({ models: z.array(modelSummarySchema).max(10_000) })
      .strict(),
  },
  setModelSettings: {
    input: modelSettingsSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export const opencodeSettingsRpcContract = defineRpcContract({
  getSettings: {
    input: z.null(),
    output: modelSettingsSchema,
  },
  listModels: {
    input: z.object({}).strict(),
    output: z
      .object({ models: z.array(modelSummarySchema).max(10_000) })
      .strict(),
  },
  saveSettings: {
    input: modelSettingsSchema,
    output: modelSettingsSchema,
  },
});

export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type ModelSummary = z.infer<typeof modelSummarySchema>;

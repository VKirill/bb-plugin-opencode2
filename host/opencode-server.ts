import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutBridgeRuntimeEnv } from "@get-bb/plugin-sdk/provider-bridge";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSettings,
} from "../model-settings.ts";
import type { ModelSettings } from "../settings-contract.ts";
import {
  forkBoundaryRetainingThrough,
  revertTargetRetainingThrough,
  type CheckpointMessage,
} from "./opencode-requests.ts";
import { OpenCodeEventRouter } from "./opencode-event-router.ts";
import { writeJsonFileAtomic } from "./persistence.ts";
import {
  errorMessage,
  inputRecord,
  stringValue,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

const SETTINGS_FILE = "opencode2-model-settings.json";
const MCP_REGISTRY_FILE = "opencode2-mcp-registry.json";

export type McpBridgeRegistration = { serverName: string; cwd: string };

export function parseOpenCodeServiceUrl(output: string): string {
  const token = output.trim().split(/\s+/)[0];
  if (!token) {
    throw new Error("`opencode2 service start` did not report a server URL");
  }

  let url: URL;
  try {
    url = new URL(token);
  } catch {
    throw new Error("`opencode2 service start` reported an invalid server URL");
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("OpenCode service must use an HTTP loopback URL");
  }
  if (url.username || url.password) {
    throw new Error("OpenCode service URL must not contain credentials");
  }
  return url.origin;
}

export class OpenCodeServer {
  private baseUrl?: string;
  private password?: string;
  private starting?: Promise<void>;
  private dataDir?: string;
  private eventAbortController?: AbortController;
  private connectionGeneration = 0;
  private readonly eventRouter = new OpenCodeEventRouter((path, init) =>
    this.request(path, init),
  );

  setDataDir(dataDir: string) {
    this.dataDir = dataDir;
  }

  private settingsPath() {
    return this.dataDir ? join(this.dataDir, SETTINGS_FILE) : undefined;
  }

  async readModelSettings(): Promise<ModelSettings> {
    const path = this.settingsPath();
    if (!path) return DEFAULT_MODEL_SETTINGS;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return normalizeModelSettings(parsed);
    } catch {
      return DEFAULT_MODEL_SETTINGS;
    }
  }

  async writeModelSettings(settings: ModelSettings) {
    const path = this.settingsPath();
    if (!path) throw new Error("OpenCode host data directory is unavailable");
    await writeJsonFileAtomic(path, settings);
  }

  // Tracks per-session MCP bridges so discard can remove OpenCode's
  // registration even when this worker holds no session state (another host
  // worker owns the thread, or this worker restarted since setup). Entries
  // persist to the host data dir; a failed DELETE keeps its entry for retry.
  private mcpRegistry = new Map<string, McpBridgeRegistration>();
  private mcpRegistryLoaded = false;
  private mcpRegistryOperation: Promise<void> = Promise.resolve();

  private mcpRegistryPath() {
    return this.dataDir ? join(this.dataDir, MCP_REGISTRY_FILE) : undefined;
  }

  private async withMcpRegistryLock<T>(operation: () => Promise<T>) {
    const result = this.mcpRegistryOperation.then(operation, operation);
    this.mcpRegistryOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadMcpRegistry() {
    if (this.mcpRegistryLoaded) return;
    this.mcpRegistryLoaded = true;
    const path = this.mcpRegistryPath();
    if (!path) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          const record = value as Record<string, unknown> | null;
          if (
            record &&
            typeof record.serverName === "string" &&
            typeof record.cwd === "string"
          ) {
            this.mcpRegistry.set(key, {
              serverName: record.serverName,
              cwd: record.cwd,
            });
          }
        }
      }
    } catch {
      // Missing or corrupt registry: treat as empty and rebuild from here.
    }
  }

  async rememberMcpRegistration(
    providerThreadId: string,
    entry: McpBridgeRegistration,
  ) {
    await this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      const previous = this.mcpRegistry.get(providerThreadId);
      this.mcpRegistry.set(providerThreadId, entry);
      try {
        await this.writeMcpRegistry();
      } catch (error) {
        if (previous) this.mcpRegistry.set(providerThreadId, previous);
        else this.mcpRegistry.delete(providerThreadId);
        throw error;
      }
    });
  }

  async forgetMcpRegistration(providerThreadId: string) {
    await this.forgetMcpRegistrations([providerThreadId]);
  }

  async forgetMcpRegistrations(providerThreadIds: readonly string[]) {
    await this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      const previous = new Map<string, McpBridgeRegistration>();
      for (const providerThreadId of providerThreadIds) {
        const entry = this.mcpRegistry.get(providerThreadId);
        if (entry) previous.set(providerThreadId, entry);
        this.mcpRegistry.delete(providerThreadId);
      }
      try {
        await this.writeMcpRegistry();
      } catch (error) {
        for (const [providerThreadId, entry] of previous) {
          this.mcpRegistry.set(providerThreadId, entry);
        }
        throw error;
      }
    });
  }

  async lookupMcpRegistration(
    providerThreadId: string,
  ): Promise<McpBridgeRegistration | undefined> {
    return this.withMcpRegistryLock(async () => {
      await this.loadMcpRegistry();
      return this.mcpRegistry.get(providerThreadId);
    });
  }

  private async writeMcpRegistry() {
    const path = this.mcpRegistryPath();
    if (!path || !this.dataDir) return;
    await writeJsonFileAtomic(path, Object.fromEntries(this.mcpRegistry));
  }

  async start() {
    if (this.baseUrl) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    const generation = ++this.connectionGeneration;
    this.starting = this.connect(generation);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async connect(generation: number) {
    // OpenCode runs one shared background service for everything. Connect to
    // it instead of spawning a private server: per-worker servers would hold
    // disjoint session state, so sessions created on one worker could not be
    // resumed from another.
    const status = await this.cli(["service", "start"]);
    const url = parseOpenCodeServiceUrl(status);
    await this.servicePassword();
    if (generation !== this.connectionGeneration) {
      throw new Error("OpenCode connection was stopped during startup");
    }
    this.baseUrl = url;
    this.eventAbortController?.abort();
    this.eventAbortController = new AbortController();
    void this.consumeEvents(this.eventAbortController.signal);
  }

  private async cli(args: string[]): Promise<string> {
    const { stdout } = await promisify(execFile)("opencode2", args, {
      env: withoutBridgeRuntimeEnv(process.env),
      timeout: 15_000,
    });
    return stdout;
  }

  private async servicePassword(): Promise<string> {
    if (process.env.OPENCODE_SERVER_PASSWORD)
      return process.env.OPENCODE_SERVER_PASSWORD;
    if (this.password) return this.password;
    const configHome =
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(configHome, "opencode", "service.json"), "utf8"),
      );
      const password = (parsed as Record<string, unknown> | null)?.password;
      if (typeof password === "string" && password) {
        this.password = password;
        return password;
      }
    } catch {
      // Fall through to `opencode2 pair`.
    }
    const pair = await this.cli(["pair"]);
    const match = pair.match(/^Password\s+(.+?)\s*$/m);
    if (!match) throw new Error("Could not read OpenCode service credentials");
    this.password = match[1].trim();
    return this.password;
  }

  private headers() {
    const password = process.env.OPENCODE_SERVER_PASSWORD ?? this.password;
    if (!password)
      throw new Error("OpenCode service credentials are unavailable");
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    };
  }

  async request(path: string, init: RequestInit = {}): Promise<RecordValue> {
    await this.start();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `OpenCode API ${response.status}: ${await response.text()}`,
      );
    if (response.status === 204) return {};
    return inputRecord(await response.json());
  }

  async nativeSkillNames(cwd: string) {
    try {
      const result = await this.request(
        `/api/skill?location[directory]=${encodeURIComponent(cwd)}`,
      );
      return new Set<string>(
        (Array.isArray(result.data) ? result.data : [])
          .map((value: unknown) => {
            const skill = inputRecord(value);
            return stringValue(skill.id ?? skill.name);
          })
          .filter(
            (name: string | undefined): name is string => name !== undefined,
          ),
      );
    } catch {
      return undefined;
    }
  }

  async listSessionMessageIds(sessionId: string): Promise<CheckpointMessage[]> {
    const messages: CheckpointMessage[] = [];
    let cursor: string | undefined;
    const maxPages = 100;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({ order: "asc", limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const result = await this.request(
        `/api/session/${encodeURIComponent(sessionId)}/message?${query}`,
      );
      const pageMessages = Array.isArray(result.data) ? result.data : [];
      for (const msg of pageMessages) {
        const record = inputRecord(msg);
        const id = stringValue(record.id);
        if (id) messages.push({ id, type: stringValue(record.type) });
      }
      const next = stringValue(result?.cursor?.next);
      if (!next || next === cursor) break;
      if (page === maxPages - 1) {
        throw new Error(
          "OpenCode session history exceeded the pagination limit",
        );
      }
      cursor = next;
    }
    return messages;
  }

  async forkBoundaryRetainingThrough(sessionId: string, checkpointId?: string) {
    if (!checkpointId) return { type: "through" } as const;
    const messages = await this.listSessionMessageIds(sessionId);
    if (!messages.some((entry) => entry.id === checkpointId)) {
      throw new Error(`OpenCode checkpoint not found: ${checkpointId}`);
    }
    return forkBoundaryRetainingThrough(messages, checkpointId);
  }

  async rewindSessionRetainingThrough(sessionId: string, checkpointId: string) {
    let messages: CheckpointMessage[];
    try {
      messages = await this.listSessionMessageIds(sessionId);
    } catch (error) {
      throw new Error(
        `Could not list OpenCode messages for rewind: ${errorMessage(error)}`,
      );
    }
    const target = revertTargetRetainingThrough(messages, checkpointId);
    if (target === undefined) {
      await this.request(
        `/api/session/${encodeURIComponent(sessionId)}/revert/clear`,
        { method: "POST" },
      ).catch(() => {});
      return;
    }
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" },
    ).catch(() => {});
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/revert/stage`,
      {
        method: "POST",
        body: JSON.stringify({ messageID: target, files: true }),
      },
    );
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/revert/commit`,
      { method: "POST" },
    );
  }

  private async consumeEvents(signal: AbortSignal) {
    while (this.baseUrl && !signal.aborted) {
      try {
        const response = await fetch(`${this.baseUrl}/api/event`, {
          headers: this.headers(),
          signal,
        });
        if (!response.ok || !response.body)
          throw new Error(
            `OpenCode event stream returned HTTP ${response.status}`,
          );
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame
              .split("\n")
              .find((value) => value.startsWith("data: "));
            if (!line) continue;
            try {
              await this.handleEvent(JSON.parse(line.slice(6)));
            } catch {
              // Ignore malformed or unsupported provider events.
            }
          }
        }
      } catch {
        if (this.baseUrl && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  }

  async handleEvent(event: RecordValue): Promise<void> {
    await this.eventRouter.handleEvent(event);
  }

  finish(
    session: SessionState,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ): void {
    this.eventRouter.finish(session, status, error);
  }

  async stop() {
    // The background service is shared with the OpenCode app/CLI; never stop
    // it here. Just drop our reference so the event loop exits.
    this.connectionGeneration += 1;
    this.baseUrl = undefined;
    this.eventAbortController?.abort();
    this.eventAbortController = undefined;
  }
}

export const openCodeServer = new OpenCodeServer();

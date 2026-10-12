import { experimental_COMPACTION_PRESENTATION as compactionPresentation } from "@get-bb/plugin-sdk/provider-bridge";
import { dynamicToolCallRouter, emit } from "./bridge-runtime.ts";
import { OpenCodeInteractions } from "./opencode-interactions.ts";
import { toolFailureError } from "./prompt.ts";
import {
  itemKey,
  itemKeyForOpenItem,
  manualCompactionOutcomeDeltas,
  providerFailureDeltas,
} from "./timeline.ts";
import { contentText, gitDiff, toolRow, touchedPaths } from "./tool-mapping.ts";
import {
  inputRecord,
  parseInputText,
  sessionsByProviderId,
  stringValue,
  type ActiveTurn,
  type OpenCodeRecord,
  type SessionState,
} from "./types.ts";

type RecordValue = OpenCodeRecord;
type RequestOpenCode = (
  path: string,
  init?: RequestInit,
) => Promise<RecordValue>;

/**
 * OpenCode v2 reports a shell tool's exit status as `metadata.exit` on
 * `session.tool.success` (a non-zero exit is still a "success" event) and
 * appends "Exited with code N" to the content.
 */
export function shellExitCode(data: RecordValue): number | undefined {
  const candidates = [inputRecord(data.metadata).exit, data.exitCode];
  for (const value of candidates)
    if (typeof value === "number" && Number.isInteger(value)) return value;
  const match = contentText(data.content).match(/Exited with code (-?\d+)/);
  return match ? Number(match[1]) : undefined;
}

export class OpenCodeEventRouter {
  private readonly interactions: OpenCodeInteractions;
  private readonly emitTimeline: typeof emit;
  private readonly sessionLookup: ReadonlyMap<string, SessionState>;

  constructor(
    request: RequestOpenCode,
    emitTimeline: typeof emit = emit,
    sessionLookup: ReadonlyMap<string, SessionState> = sessionsByProviderId,
  ) {
    this.interactions = new OpenCodeInteractions(request);
    this.emitTimeline = emitTimeline;
    this.sessionLookup = sessionLookup;
  }

  async handleEvent(event: RecordValue): Promise<void> {
    const data = inputRecord(event.data);
    const sessionId = stringValue(data.sessionID);
    if (!sessionId) return;
    const session = this.sessionLookup.get(sessionId);
    if (!session) return;
    const active = session.active;
    if (event.type === "permission.asked") {
      void this.interactions.handlePermission(session, data);
      return;
    }
    if (!active) return;
    const eventId = stringValue(data.id) ?? "";
    const eventType = stringValue(event.type) ?? "";
    if (eventType.startsWith("session.tool.") && !eventId) return;
    if (this.handleCompactionEvent(session, active, event.type, data)) return;
    const assistantMessageId = stringValue(data.assistantMessageID);
    const ordinal =
      typeof data.ordinal === "number" && Number.isSafeInteger(data.ordinal)
        ? data.ordinal
        : undefined;
    const textPartId =
      assistantMessageId && ordinal !== undefined
        ? `text:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.text.started" && textPartId) {
      const item = { type: "agentMessage", text: "" };
      active.opened.set(textPartId, item);
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(textPartId, "agentMessage"),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.delta" &&
      textPartId &&
      typeof data.delta === "string"
    ) {
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.delta,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.text.ended" &&
      textPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(textPartId) ?? {
        type: "agentMessage",
        text: data.text,
      };
      item.text = data.text;
      active.opened.delete(textPartId);
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(textPartId, "agentMessage"),
          channel: "agentMessage",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(textPartId, "agentMessage"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    const reasoningPartId =
      assistantMessageId && ordinal !== undefined
        ? `reasoning:${assistantMessageId}:${ordinal}`
        : undefined;
    if (event.type === "session.reasoning.started" && reasoningPartId) {
      const item = { type: "reasoning", summary: [], content: [] };
      active.opened.set(reasoningPartId, item);
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.open",
          key: itemKey(reasoningPartId, "reasoningText"),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.delta" &&
      reasoningPartId &&
      typeof data.delta === "string"
    ) {
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.textDelta",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.delta,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (
      event.type === "session.reasoning.ended" &&
      reasoningPartId &&
      typeof data.text === "string"
    ) {
      const item = active.opened.get(reasoningPartId) ?? {
        type: "reasoning",
        summary: [],
        content: [],
      };
      item.content = [data.text];
      active.opened.delete(reasoningPartId);
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.textClose",
          key: itemKey(reasoningPartId, "reasoningText"),
          channel: "reasoningText",
          text: data.text,
          providerTurnId: active.providerTurnId,
        },
        {
          kind: "item.close",
          key: itemKey(reasoningPartId, "reasoningText"),
          status: "completed",
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (event.type === "session.tool.input.started") {
      const toolName = stringValue(data.name);
      if (eventId && toolName) active.pendingTools.set(eventId, toolName);
    }
    if (event.type === "session.tool.input.ended") {
      if (eventId && typeof data.text === "string")
        active.pendingInput.set(eventId, data.text);
    }
    if (event.type === "session.tool.called") {
      const name = active.pendingTools.get(eventId);
      if (name) {
        const input = inputRecord(
          data.input ?? parseInputText(active.pendingInput.get(eventId)),
        );
        const row = toolRow(name, input, session.cwd);
        active.opened.set(eventId, row.item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emitTimeline(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item: row.item,
            presentation: row.presentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
        // OpenCode's question tool blocks forever waiting on an interactive
        // form that no TUI will answer in a BB thread. Relay it to BB's
        // native question UI instead (see handleQuestion).
        if (name.toLowerCase() === "question") {
          void this.interactions
            .handleQuestion(session, active, eventId)
            .catch(() => {});
        }
      } else {
        const item = active.opened.get(eventId);
        if (item) item.args = data.input;
      }
    }
    if (
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      // handleQuestion may already have closed + answered this call.
      if (active.settledTools.has(eventId)) {
        active.settledTools.delete(eventId);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        active.pendingTools.delete(eventId);
        return;
      }
      const name =
        active.pendingTools.get(eventId) ??
        stringValue(data.name) ??
        "OpenCode tool";
      const input = inputRecord(
        data.input ?? parseInputText(active.pendingInput.get(eventId)),
      );
      let item = active.opened.get(eventId);
      if (!item) {
        const row = toolRow(name, input, session.cwd);
        item = row.item;
        active.opened.set(eventId, item);
        const touched = touchedPaths(name, input);
        if (touched.length) active.touchedFiles.set(eventId, touched);
        active.pendingTools.delete(eventId);
        active.pendingInput.delete(eventId);
        this.emitTimeline(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(eventId, "tool"),
            item,
            presentation: row.presentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
      const output = contentText(data.content);
      if (item.type === "tool") {
        if (event.type === "session.tool.success") item.result = output;
        else {
          const error = inputRecord(data.error);
          item.error = toolFailureError(
            name,
            session.disableSubagents,
            stringValue(error.message),
          );
        }
      } else if (item.type === "command") {
        const error = inputRecord(data.error);
        item.aggregatedOutput =
          event.type === "session.tool.success"
            ? output
            : (stringValue(error.message) ?? "OpenCode tool failed");
        const exitCode = shellExitCode(data);
        item.exitCode =
          event.type === "session.tool.success"
            ? (exitCode ?? 0)
            : (exitCode ?? 1);
      }
      active.opened.delete(eventId);
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKey(eventId, "tool"),
          status:
            event.type.endsWith("failed") ||
            (item.type === "command" && item.exitCode !== 0)
              ? "failed"
              : "completed",
          ...(item.type === "tool" && item.result
            ? { resultText: item.result }
            : {}),
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
      if (event.type === "session.tool.success") {
        const touched =
          active.touchedFiles.get(eventId) ?? touchedPaths(name, input);
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
        if (touched.length) {
          await this.emitFileChanges(
            session,
            active,
            `files:${eventId}`,
            touched,
          );
        }
      } else {
        active.touchedFiles.delete(eventId);
        active.pendingInput.delete(eventId);
      }
    }
    if (event.type === "session.step.ended") {
      const tokens = inputRecord(data.tokens);
      const cache = inputRecord(tokens.cache);
      const tokenCount = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : 0;
      const cachedWriteTokens = tokenCount(cache.write);
      const last = {
        inputTokens: tokenCount(tokens.input),
        outputTokens: tokenCount(tokens.output),
        reasoningOutputTokens: tokenCount(tokens.reasoning),
        cachedInputTokens: tokenCount(cache.read),
        totalTokens:
          tokenCount(tokens.input) +
          tokenCount(tokens.output) +
          tokenCount(tokens.reasoning) +
          tokenCount(cache.read) +
          cachedWriteTokens,
      };
      session.usage = {
        input: session.usage.input + last.inputTokens,
        output: session.usage.output + last.outputTokens,
        reasoning: session.usage.reasoning + last.reasoningOutputTokens,
        cacheRead: session.usage.cacheRead + last.cachedInputTokens,
        cacheWrite: session.usage.cacheWrite + cachedWriteTokens,
      };
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "usage",
          total: {
            ...last,
            inputTokens: session.usage.input,
            outputTokens: session.usage.output,
            reasoningOutputTokens: session.usage.reasoning,
            cachedInputTokens: session.usage.cacheRead,
            totalTokens:
              session.usage.input +
              session.usage.output +
              session.usage.reasoning +
              session.usage.cacheRead +
              session.usage.cacheWrite,
          },
          last,
          modelContextWindow: null,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    if (event.type === "session.execution.succeeded")
      this.finish(session, "completed");
    if (event.type === "session.execution.interrupted")
      this.finish(session, "interrupted");
    if (event.type === "session.execution.failed") {
      const error = inputRecord(data.error);
      this.finish(
        session,
        "failed",
        stringValue(error.message) ?? "OpenCode execution failed",
      );
    }
  }

  private handleCompactionEvent(
    session: SessionState,
    active: ActiveTurn,
    type: unknown,
    data: RecordValue,
  ) {
    const eventType = stringValue(type);
    if (!eventType) return false;
    const message = inputRecord(data.message ?? data.info);
    const messageId = stringValue(
      data.messageID ?? data.messageId ?? data.id ?? message.id,
    );
    const reason = stringValue(data.reason ?? message.reason);
    const status = stringValue(data.status ?? message.status);
    const itemId = messageId ?? active.manualCompaction?.itemId;
    const isStarted =
      eventType === "session.next.compaction.started" ||
      eventType === "session.compaction.started" ||
      (eventType === "session.message.updated" &&
        status === "running" &&
        message.type === "compaction");
    const isCompleted =
      eventType === "session.next.compaction.ended" ||
      eventType === "session.compaction.ended" ||
      eventType === "session.compacted" ||
      (eventType === "session.message.updated" &&
        status === "completed" &&
        message.type === "compaction");
    const isFailed =
      eventType === "session.compaction.failed" ||
      (eventType === "session.message.updated" &&
        status === "failed" &&
        message.type === "compaction");
    if (!isStarted && !isCompleted && !isFailed) return false;

    if (isStarted) {
      if (itemId && !active.opened.has(itemId)) {
        const item = { type: "compaction" };
        active.opened.set(itemId, item);
        this.emitTimeline(session.bbThreadId, [
          {
            kind: "item.open",
            key: itemKey(itemId, "compaction"),
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
      return true;
    }

    const error =
      stringValue(
        data.error?.message ??
          data.error ??
          message.error?.message ??
          message.error,
      ) ?? "OpenCode context compaction failed";
    const manualCompaction = active.manualCompaction;
    const manual =
      manualCompaction !== undefined &&
      (itemId === manualCompaction.itemId ||
        reason === "manual" ||
        eventType === "session.compacted");
    if (manual && manualCompaction) {
      active.opened.delete(manualCompaction.itemId);
      this.emitTimeline(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
          messageId: manualCompaction.itemId,
          status: isCompleted ? "completed" : "failed",
          ...(isFailed ? { error } : {}),
        }),
      );
      active.openQuestions.clear();
      active.settledTools.clear();
      active.pendingTools.clear();
      active.pendingInput.clear();
      active.touchedFiles.clear();
      active.abortController.abort();
      session.active = undefined;
      return true;
    }

    if (itemId) {
      const item = active.opened.get(itemId);
      if (item) {
        active.opened.delete(itemId);
        this.emitTimeline(session.bbThreadId, [
          {
            kind: "item.close",
            key: itemKey(itemId, "compaction"),
            status: isCompleted ? "completed" : "failed",
            item,
            presentation: compactionPresentation,
            providerTurnId: active.providerTurnId,
          },
        ]);
      }
    }
    if (isCompleted)
      this.emitTimeline(session.bbThreadId, [
        { kind: "context.compacted", providerTurnId: active.providerTurnId },
      ]);
    return true;
  }

  private async emitFileChanges(
    session: SessionState,
    active: ActiveTurn,
    key: string,
    paths: string[],
  ): Promise<void> {
    // OpenCode's step.ended carries no file list, and write/edit rows are
    // suppressed, so render the change from the tool input recorded at call
    // time. The event reader awaits this method to preserve delta ordering.
    const changes = await Promise.all(
      paths.map(async (file) => {
        const diff = await gitDiff(session.cwd, file);
        return { path: file, kind: "update", ...(diff ? { diff } : {}) };
      }),
    );
    const item = { type: "fileChange", changes };
    this.emitTimeline(session.bbThreadId, [
      {
        kind: "item.open",
        key: itemKey(key, "fileChange"),
        item,
        providerTurnId: active.providerTurnId,
      },
      {
        kind: "item.close",
        key: itemKey(key, "fileChange"),
        status: "completed",
        item,
        providerTurnId: active.providerTurnId,
      },
    ]);
  }

  finish(
    session: SessionState,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ) {
    const active = session.active;
    if (!active) return;
    active.abortController.abort();
    if (active.manualCompaction) {
      this.emitTimeline(
        session.bbThreadId,
        manualCompactionOutcomeDeltas({
          providerTurnId: active.providerTurnId,
          messageId: active.manualCompaction.itemId,
          status,
          ...(error ? { error } : {}),
        }),
      );
      session.active = undefined;
      return;
    }
    dynamicToolCallRouter.resolve(
      session.dynamicToolScope,
      "OpenCode turn ended before the BB tool returned",
    );
    for (const [, formId] of active.openQuestions)
      void this.interactions.cancelQuestionForm(session, formId);
    for (const [id, item] of active.opened) {
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "item.close",
          key: itemKeyForOpenItem(id, item),
          status,
          item,
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    active.opened.clear();
    active.openQuestions.clear();
    active.settledTools.clear();
    active.pendingTools.clear();
    active.pendingInput.clear();
    active.touchedFiles.clear();
    if (status === "failed") {
      this.emitTimeline(
        session.bbThreadId,
        providerFailureDeltas({
          providerTurnId: active.providerTurnId,
          error: error ?? "OpenCode execution failed",
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
        }),
      );
    } else {
      this.emitTimeline(session.bbThreadId, [
        {
          kind: "turn.boundary",
          status,
          ...(active.checkpointId
            ? { providerCheckpointId: active.checkpointId }
            : {}),
          providerTurnId: active.providerTurnId,
        },
      ]);
    }
    session.active = undefined;
  }
}

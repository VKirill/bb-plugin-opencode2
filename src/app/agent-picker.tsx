import { useComposer, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AGENT_OPTION_ID,
  DEFAULT_AGENT,
  opencodeSettingsRpcContract,
} from "../settings-contract.ts";

const PROVIDER_ID = "opencode2";
const FIND_RETRY_MS = 1_000;
const FIND_RETRIES = 20;

type AgentValue = { id: string; label: string; description?: string | null };
type AgentChoice = { values: AgentValue[]; current: string };

function BotIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}

type SessionOptionLike = {
  id: string;
  type: string;
  value?: unknown;
  pendingValue?: unknown;
  values?: AgentValue[];
};

function agentOption(options: readonly SessionOptionLike[] | null | undefined) {
  const option = options?.find(
    (candidate) =>
      candidate.id === AGENT_OPTION_ID && candidate.type === "select",
  );
  return option?.values && option.values.length > 0 ? option : undefined;
}

/**
 * The agent picker's state. OpenCode's agents are a BB session option, so BB
 * owns the real choice: an existing thread reads and writes it through the
 * thread's session options. A new-thread composer has no thread to write to
 * yet, so its pick waits in the plugin until the thread's first turn.
 */
function useAgentChoice() {
  const composer = useComposer();
  const sdk = useSdk();
  const rpc = useRpc<typeof opencodeSettingsRpcContract>();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  const isOpenCode = composer.selection?.providerId === PROVIDER_ID;
  const [choice, setChoice] = useState<AgentChoice | null>(null);

  // Resolves true once the agent option was found.
  const load = useCallback(async (): Promise<boolean> => {
    try {
      if (threadId) {
        const timeline = await sdkRef.current.threads.timeline({
          threadId,
          summaryOnly: "true",
        });
        const option = agentOption(timeline.sessionOptions);
        setChoice(
          option
            ? {
                values: option.values!,
                current: String(option.pendingValue ?? option.value),
              }
            : null,
        );
        return option !== undefined;
      } else if (projectId) {
        const [models, pick] = await Promise.all([
          sdkRef.current.providers.models({
            projectId,
            providerId: PROVIDER_ID,
          }),
          rpcRef.current.call("getNewThreadAgent", { projectId }),
        ]);
        const option = models.models
          .map((model) => agentOption(model.sessionOptions))
          .find(Boolean);
        setChoice(
          option
            ? {
                values: option.values!,
                current:
                  pick.agent && option.values!.some((v) => v.id === pick.agent)
                    ? pick.agent
                    : String(option.value ?? DEFAULT_AGENT),
              }
            : null,
        );
        return option !== undefined;
      }
    } catch {
      setChoice(null);
    }
    return false;
  }, [threadId, projectId]);

  // Reload when the composer changes and when a turn starts or ends. A new
  // thread's host reports the option a moment after the thread opens, so keep
  // looking for a while instead of waiting for the first reply to finish.
  useEffect(() => {
    if (!isOpenCode) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (remaining: number) => {
      const found = await load();
      if (cancelled || found || remaining <= 0 || !threadId) return;
      timer = setTimeout(() => void attempt(remaining - 1), FIND_RETRY_MS);
    };
    void attempt(FIND_RETRIES);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpenCode, load, threadId, composer.isRunning]);

  const choose = useCallback(
    async (agent: string) => {
      setChoice((previous) => previous && { ...previous, current: agent });
      try {
        if (threadId) {
          await sdkRef.current.threads.update({
            threadId,
            sessionOptions: { [AGENT_OPTION_ID]: agent },
          });
        } else if (projectId) {
          await rpcRef.current.call("setNewThreadAgent", { projectId, agent });
        }
      } finally {
        void load();
      }
    },
    [threadId, projectId, load],
  );

  return { choice: isOpenCode ? choice : null, choose };
}

/**
 * Composer dropdown for OpenCode's primary agents. The agents are a BB session
 * option (so `bb thread spawn --option agent=<name>` works too); this is only
 * a nicer control for it. It stays hidden until OpenCode has a primary agent
 * besides `build` and `plan`, because the host only declares the option then.
 */
export function AgentPicker() {
  const { choice, choose } = useAgentChoice();
  if (!choice) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="OpenCode agent"
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-input px-2 text-xs hover:bg-state-hover data-[state=open]:bg-state-active"
        >
          <BotIcon />
          {choice.current}
          <span aria-hidden>▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end">
        <DropdownMenuLabel>Primary agents</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={choice.current}
          onValueChange={(value) => void choose(value)}
        >
          {choice.values.map((agent) => (
            <DropdownMenuRadioItem key={agent.id} value={agent.id}>
              <span className="text-sm">{agent.label}</span>
              {agent.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {agent.description}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

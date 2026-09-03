import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  modelSettingsSchema,
  opencodeSettingsRpcContract,
  type ModelSettings,
  type ModelSummary,
} from "../settings-contract.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

function groupByProvider(models: ModelSummary[]) {
  const map = new Map<string, ModelSummary[]>();
  for (const model of models) {
    const list = map.get(model.providerId) ?? [];
    list.push(model);
    map.set(model.providerId, list);
  }
  return [...map.entries()]
    .map(([providerId, items]) => ({
      providerId,
      items: items.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function SettingRow({
  title,
  description,
  checked,
  disabled,
  label,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function SettingsSection() {
  const rpc = useRpc<typeof opencodeSettingsRpcContract>();
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const operationId = useRef(0);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useRealtime("settings-changed", (payload) => {
    const parsed = modelSettingsSchema.safeParse(payload);
    if (parsed.success) setSettings(parsed.data);
  });

  const load = useCallback(async () => {
    const id = ++operationId.current;
    setIsLoading(true);
    setError(null);
    try {
      const [nextSettings, nextModels] = await Promise.all([
        rpcRef.current.call("getSettings", null),
        rpcRef.current.call("listModels", {}),
      ]);
      if (id !== operationId.current) return;
      setSettings(nextSettings);
      setModels(nextModels.models);
    } catch (cause) {
      if (id === operationId.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (id === operationId.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      operationId.current += 1;
    };
  }, [load]);

  async function save(next: ModelSettings) {
    if (!settings || isSaving) return;
    const previous = settings;
    const id = ++operationId.current;
    setSettings(next);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await rpcRef.current.call("saveSettings", next);
      if (id === operationId.current) setSettings(saved);
    } catch (cause) {
      if (id === operationId.current) {
        setSettings(previous);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (id === operationId.current) setIsSaving(false);
    }
  }

  const isEnabled = (model: ModelSummary): boolean => {
    if (!settings) return false;
    return (
      settings.enabledModels === null ||
      settings.enabledModels.includes(model.id)
    );
  };

  const providers = useMemo(() => groupByProvider(models), [models]);

  const visibleProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers
      .map((group) => ({
        ...group,
        items: group.items.filter((model) =>
          `${model.displayName} ${model.providerId} ${model.id}`
            .toLowerCase()
            .includes(q),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [providers, query]);

  function setModelEnabled(model: ModelSummary, nextEnabled: boolean) {
    if (!settings) return;
    const current =
      settings.enabledModels === null
        ? new Set(models.map((item) => item.id))
        : new Set(settings.enabledModels);
    if (nextEnabled) current.add(model.id);
    else current.delete(model.id);
    void save({ ...settings, enabledModels: [...current].sort() });
  }

  function setProviderEnabled(providerId: string, nextEnabled: boolean) {
    if (!settings) return;
    const base =
      settings.enabledModels === null
        ? new Set(models.map((item) => item.id))
        : new Set(settings.enabledModels);
    for (const model of models) {
      if (model.providerId !== providerId) continue;
      if (nextEnabled) base.add(model.id);
      else base.delete(model.id);
    }
    void save({ ...settings, enabledModels: [...base].sort() });
  }

  function setAllModels(nextEnabled: boolean) {
    if (!settings) return;
    void save({ ...settings, enabledModels: nextEnabled ? null : [] });
  }

  const busy = settings === null || isSaving;

  return (
    <div className="opencode-settings">
      <div className="text-sm font-medium">Configuration</div>

      <div className="rounded-lg border border-border p-4">
        <div className="flex flex-col gap-4">
          <SettingRow
            title="Provider enabled"
            description="Show OpenCode v2 in the provider picker."
            checked={settings?.providerEnabled ?? false}
            disabled={busy}
            label="Enable OpenCode v2 provider"
            onCheckedChange={(next) => {
              if (settings) void save({ ...settings, providerEnabled: next });
            }}
          />
          <SettingRow
            title="Disable provider subagents"
            description="Prevent OpenCode from starting native subagents so agents use BB for delegation."
            checked={settings?.disableSubagents !== false}
            disabled={busy}
            label="Disable provider subagents"
            onCheckedChange={(next) => {
              if (settings) void save({ ...settings, disableSubagents: next });
            }}
          />
        </div>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-sm font-medium">Models</div>
          <div className="text-sm text-muted-foreground">
            Only enabled models appear in the OpenCode v2 picker.
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || models.length === 0}
            onClick={() => setAllModels(true)}
          >
            Enable all
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || models.length === 0}
            onClick={() => setAllModels(false)}
          >
            Disable all
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <Input
          aria-label="Search OpenCode models"
          placeholder="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={isLoading || isSaving}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground" role="status">
          Loading models…
        </div>
      ) : null}
      {isSaving ? (
        <div className="text-sm text-muted-foreground" role="status">
          Saving…
        </div>
      ) : null}
      {error ? (
        <div className="text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {!isLoading && models.length === 0 && !error ? (
        <div className="text-sm text-muted-foreground">
          No OpenCode models were found on a connected host.
        </div>
      ) : null}
      {!isLoading && models.length > 0 && visibleProviders.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No models match your search.
        </div>
      ) : null}

      {!isLoading && !error
        ? visibleProviders.map((group) => {
            const groupEnabled = group.items.filter(isEnabled).length;
            const allOn = groupEnabled === group.items.length;
            return (
              <div key={group.providerId}>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm text-muted-foreground">
                    {group.providerId} · {groupEnabled}/{group.items.length}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setProviderEnabled(group.providerId, !allOn)}
                  >
                    {allOn ? "Disable" : "Enable"}
                  </Button>
                </div>
                <div className="rounded-lg border border-border">
                  {group.items.map((model) => (
                    <div
                      key={model.id}
                      className="flex items-center justify-between gap-4 border-b border-border p-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm">
                          {model.displayName}
                        </div>
                        <div className="truncate text-sm text-muted-foreground">
                          {model.id}
                        </div>
                      </div>
                      <Switch
                        aria-label={`Enable ${model.displayName} from ${model.providerId}`}
                        checked={isEnabled(model)}
                        disabled={busy}
                        onCheckedChange={(next) => setModelEnabled(model, next)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        : null}

      <div className="text-xs text-muted-foreground">
        Changes apply when BB refreshes the provider model catalog.
      </div>
    </div>
  );
}

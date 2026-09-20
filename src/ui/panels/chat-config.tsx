import type { KeyboardEvent } from "react";
import { useState } from "react";
import type { ConfigDraft } from "../../chat/config";
import { threadConfigPatch, validateConfigDraft } from "../../chat/config";
import { useChatStore } from "../../chat/store";
import type { ChatThread, SkillRef } from "../../chat/types";
import { useSession } from "../../session/session-context";
import { DataEgressNotice } from "../../settings/DataEgressNotice";
import { ProvidersPanel } from "../../settings/ProvidersPanel";
import { StorageWarning } from "../../settings/StorageWarning";
import { useVaultStore } from "../../vault/store";
import { Button, Input, Row, Select, Textarea } from "../primitives";

export type ConfigTab = "thread" | "providers" | "vault";

const TABS: readonly ConfigTab[] = ["thread", "providers", "vault"];
const TAB_LABEL: Record<ConfigTab, string> = {
  thread: "Thread",
  providers: "Providers",
  vault: "Vault",
};

function toDraft(thread: ChatThread): ConfigDraft {
  const { config } = thread;
  return {
    providerId: config.providerId,
    modelId: config.modelId ?? "",
    systemInstruction: config.systemInstruction,
    temperature: config.params.temperature?.toString() ?? "",
    topP: config.params.topP?.toString() ?? "",
    topK: config.params.topK?.toString() ?? "",
    maxOutputTokens: config.params.maxOutputTokens?.toString() ?? "",
    maxContextTokens: config.maxContextTokens?.toString() ?? "",
    providerOptions: config.providerOptions
      ? JSON.stringify(config.providerOptions, null, 2)
      : "",
    enabledSkills: config.enabledSkills,
  };
}

function ThreadTab({ thread }: { thread: ChatThread }) {
  const session = useSession();
  const settings = useVaultStore((s) => s.settings);
  const [draft, setDraft] = useState<ConfigDraft>(() => toDraft(thread));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const providers = settings?.providers ?? [];
  const provider = providers.find((entry) => entry.id === draft.providerId);
  const skills = session.skillRegistry.list();

  const set = (patch: Partial<ConfigDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const toggleSkill = (ref: SkillRef) => {
    const exists = draft.enabledSkills.some(
      (skill) => skill.id === ref.id && skill.source === ref.source,
    );
    set({
      enabledSkills: exists
        ? draft.enabledSkills.filter(
            (skill) => !(skill.id === ref.id && skill.source === ref.source),
          )
        : [...draft.enabledSkills, ref],
    });
  };

  const save = async () => {
    let candidate: unknown;
    try {
      candidate = threadConfigPatch(draft);
    } catch (error) {
      setErrors({
        providerOptions:
          error instanceof Error ? error.message : "Invalid input.",
      });
      return;
    }
    const result = validateConfigDraft(candidate);
    if (!result.config) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const next: ChatThread = {
      ...thread,
      config: result.config,
      updatedAt: Date.now(),
    };
    useChatStore.getState().setThread(next);
    try {
      await session.threadStore.saveThread(next);
      setSavedAt(Date.now());
    } catch (error) {
      // Keep the draft; surface the failure instead of claiming success.
      setErrors({
        _form:
          error instanceof Error
            ? error.message
            : "The config could not be saved.",
      });
    }
  };

  const reset = () => {
    setDraft(toDraft(thread));
    setErrors({});
  };

  return (
    <div className="flex flex-col px-3 py-2">
      <Row label="Provider" error={errors.providerId}>
        <Select
          size="sm"
          value={draft.providerId}
          onChange={(event) => {
            const nextProvider = providers.find(
              (entry) => entry.id === event.target.value,
            );
            set({
              providerId: event.target.value,
              modelId: nextProvider?.defaultModel ?? "",
            });
          }}
        >
          {providers.length === 0 ? (
            <option value="">No providers configured</option>
          ) : null}
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </Select>
      </Row>

      <Row label="Model" error={errors.modelId}>
        <Select
          size="sm"
          value={draft.modelId}
          onChange={(event) => set({ modelId: event.target.value })}
        >
          {(provider?.models.length
            ? provider.models
            : draft.modelId
              ? [draft.modelId]
              : [""]
          ).map((model) => (
            <option key={model} value={model}>
              {model || "Default model"}
            </option>
          ))}
        </Select>
      </Row>

      <Row label="System instruction" error={errors.systemInstruction}>
        <Textarea
          size="sm"
          className="font-mono"
          value={draft.systemInstruction}
          onChange={(event) => set({ systemInstruction: event.target.value })}
          rows={4}
        />
      </Row>

      <Row label="Temperature" hint="0 to 2" error={errors.temperature}>
        <Input
          size="sm"
          value={draft.temperature}
          onChange={(event) => set({ temperature: event.target.value })}
        />
      </Row>
      <Row label="Top P" hint="0 to 1" error={errors.topP}>
        <Input
          size="sm"
          value={draft.topP}
          onChange={(event) => set({ topP: event.target.value })}
        />
      </Row>
      <Row label="Top K" hint="positive integer" error={errors.topK}>
        <Input
          size="sm"
          value={draft.topK}
          onChange={(event) => set({ topK: event.target.value })}
        />
      </Row>
      <Row
        label="Max output tokens"
        hint="positive integer"
        error={errors.maxOutputTokens}
      >
        <Input
          size="sm"
          value={draft.maxOutputTokens}
          onChange={(event) => set({ maxOutputTokens: event.target.value })}
        />
      </Row>
      <Row
        label="Max context tokens"
        hint="blank uses the global cap"
        error={errors.maxContextTokens}
      >
        <Input
          size="sm"
          value={draft.maxContextTokens}
          onChange={(event) => set({ maxContextTokens: event.target.value })}
        />
      </Row>
      <Row
        label="Provider options"
        hint="JSON object"
        error={errors.providerOptions}
      >
        <Textarea
          size="sm"
          className="font-mono"
          value={draft.providerOptions}
          onChange={(event) => set({ providerOptions: event.target.value })}
          rows={3}
          spellCheck={false}
        />
      </Row>

      <Row label="Enabled skills" error={errors._form}>
        {skills.length === 0 ? (
          <p className="text-xs text-faint">No skills registered.</p>
        ) : (
          <div className="flex flex-col">
            {skills.map((skill) => {
              const ref: SkillRef = { id: skill.id, source: skill.source };
              const checked = draft.enabledSkills.some(
                (entry) => entry.id === ref.id && entry.source === ref.source,
              );
              return (
                <label
                  key={`${skill.source}:${skill.id}`}
                  className="flex items-center gap-2 py-0.5 text-sm text-ink"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSkill(ref)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {skill.id}
                  </span>
                  <span className="shrink-0 text-xs text-faint">
                    {skill.source}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </Row>

      <div className="mt-2 flex items-center gap-2 border-t border-rule pt-3">
        <Button size="sm" variant="primary" onClick={() => void save()}>
          Save config
        </Button>
        <Button size="sm" variant="quiet" onClick={reset}>
          Reset
        </Button>
        {savedAt ? (
          <span className="font-mono text-xs text-positive">Saved</span>
        ) : null}
      </div>
    </div>
  );
}

export function ChatConfig({
  tab,
  onTabChange,
}: {
  tab: ConfigTab;
  onTabChange(tab: ConfigTab): void;
}) {
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const thread = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId] : undefined,
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % TABS.length
        : (index - 1 + TABS.length) % TABS.length;
    onTabChange(TABS[next]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Chat configuration"
        onKeyDown={onKeyDown}
        className="flex shrink-0 items-center gap-0.5 border-b border-rule px-1.5 py-1"
      >
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            tabIndex={tab === entry ? 0 : -1}
            onClick={() => onTabChange(entry)}
            className={`rounded-sm px-2 py-1 text-sm transition-colors ${
              tab === entry
                ? "bg-accent-soft text-accent"
                : "text-muted hover:text-ink"
            }`}
          >
            {TAB_LABEL[entry]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "thread" ? (
          thread ? (
            <ThreadTab key={activeThreadId} thread={thread} />
          ) : (
            <p className="px-3 py-3 text-xs text-faint">
              Select a conversation to edit its config.
            </p>
          )
        ) : null}
        {tab === "providers" ? <ProvidersPanel /> : null}
        {tab === "vault" ? (
          <div className="flex flex-col gap-2 p-3">
            <StorageWarning />
            <DataEgressNotice />
          </div>
        ) : null}
      </div>
    </div>
  );
}

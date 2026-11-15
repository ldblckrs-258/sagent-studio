import { generateText } from "ai";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createLLM } from "../ai/llm";
import { ModelManager } from "../ai/model-manager";
import type { ProviderValidationErrors } from "../ai/providers";
import { MAX_PROVIDERS, validateProvider } from "../ai/providers";
import { SecretField } from "../ai/secret-field";
import { Button, EmptyState, Input, Row } from "../ui/primitives";
import type { ProviderConfig, Settings } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import { PlaygroundProvidersSection } from "./PlaygroundProvidersSection";
import { SectionHeader } from "./SectionHeader";

export type ProvidersSection = "llm" | "typesafe" | "playground";

const SECTIONS: readonly ProvidersSection[] = ["llm", "typesafe", "playground"];

const SECTION_LABEL: Record<ProvidersSection, string> = {
  llm: "LLM",
  typesafe: "TypeSafe",
  playground: "Playground",
};

function emptyProvider(): ProviderConfig {
  return {
    id: `provider-${Date.now().toString(36)}`,
    label: "",
    kind: "openai-compatible",
    baseURL: "",
    apiKey: "",
    models: [],
    defaultModel: "",
  };
}

type ConnectionState = {
  status: "idle" | "testing" | "ok" | "error";
  message?: string;
};

function ProviderEntry({
  provider,
  startExpanded = false,
  onSave,
  onDelete,
}: {
  provider: ProviderConfig;
  startExpanded?: boolean;
  onSave: (next: ProviderConfig) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(provider);
  const [errors, setErrors] = useState<ProviderValidationErrors>({});
  const [connection, setConnection] = useState<ConnectionState>({
    status: "idle",
  });
  const [expanded, setExpanded] = useState(startExpanded);
  const [saving, setSaving] = useState(false);

  const patch = (next: Partial<ProviderConfig>) =>
    setDraft((prev) => ({ ...prev, ...next }));

  const save = async () => {
    setErrors({});
    const found = validateProvider(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await onSave(draft);
      setConnection({ status: "idle" });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    const found = validateProvider(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setConnection({ status: "testing" });
    try {
      const settings = useVaultStore.getState().settings;
      if (!settings) throw new Error("Vault is locked.");
      const model = createLLM({ ...settings, providers: [draft] }, draft.id);
      await generateText({ model, prompt: "Reply with the single word: ok" });
      setConnection({ status: "ok", message: "Connection succeeded." });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connection failed.";
      setConnection({
        status: "error",
        message: message.replaceAll(draft.apiKey, "***"),
      });
    }
  };

  const host = (() => {
    try {
      return new URL(draft.baseURL).host;
    } catch {
      return draft.baseURL || "not set";
    }
  })();

  return (
    <article className="border-t border-rule">
      <div className="flex items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-ink">
            {draft.label || "Untitled provider"}
          </h3>
          <p className="truncate font-mono text-xs text-faint">
            {host}
            {draft.models.length > 0
              ? ` · ${draft.models.length === 1 ? "1 model" : `${draft.models.length} models`}`
              : ""}
            {draft.defaultModel ? ` · ${draft.defaultModel}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="quiet"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            icon={
              <ChevronDown
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                className={`transition-transform duration-200 ease-out-quart ${expanded ? "rotate-180" : ""}`}
              />
            }
          >
            {expanded ? "Hide" : "Edit"}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="pb-3 motion-safe:animate-[panel-in_200ms_var(--ease-out-quart)]">
          <Row
            label="Label"
            hint="Shown in provider lists."
            error={errors.label}
          >
            <Input
              size="sm"
              value={draft.label}
              placeholder="Local llama.cpp"
              onChange={(event) => patch({ label: event.target.value })}
            />
          </Row>
          <Row
            label="Endpoint"
            hint="OpenAI-compatible base URL."
            error={errors.baseURL}
          >
            <Input
              size="sm"
              value={draft.baseURL}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => patch({ baseURL: event.target.value })}
            />
          </Row>
          <Row
            label="Credential"
            hint="Stored encrypted, never shown in full."
            error={errors.apiKey}
          >
            <SecretField
              name={`provider-${draft.id}-apiKey`}
              storedValue={draft.apiKey}
              onChange={(value) => patch({ apiKey: value })}
            />
          </Row>
          <Row
            label="Models"
            hint="Fetched from the provider, or added by hand."
            error={errors.models ?? errors.defaultModel}
          >
            <ModelManager
              provider={draft}
              models={draft.models}
              defaultModel={draft.defaultModel}
              onModelsChange={(models) => patch({ models })}
              onDefaultModelChange={(defaultModel) => patch({ defaultModel })}
            />
          </Row>

          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-rule pt-3">
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => void save()}
              disabled={saving}
              icon={
                saving ? (
                  <LoaderCircle
                    size={14}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="motion-safe:animate-spin"
                  />
                ) : undefined
              }
            >
              {saving ? "Saving" : "Save provider"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void testConnection()}
              disabled={connection.status === "testing"}
              icon={
                connection.status === "testing" ? (
                  <LoaderCircle
                    size={14}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="motion-safe:animate-spin"
                  />
                ) : undefined
              }
            >
              {connection.status === "testing" ? "Testing" : "Test connection"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              onClick={() => void onDelete()}
              icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              Delete
            </Button>
          </div>

          {connection.message ? (
            <p
              role="status"
              className={`mt-2 flex items-start gap-1.5 font-mono text-xs ${
                connection.status === "ok" ? "text-positive" : "text-danger"
              }`}
            >
              {connection.status === "ok" ? (
                <CircleCheck
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
              ) : (
                <CircleX
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
              )}
              {connection.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TypeSafeSection({ settings }: { settings: Settings }) {
  const update = useVaultStore((s) => s.update);
  const [draft, setDraft] = useState(settings.typesafe);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = (next: typeof draft) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // A lock may win the race with this debounced write; that is benign and
      // must not surface as a vault failure.
      void update({ typesafe: next }).catch(() => undefined);
    }, 400);
  };

  const patch = (next: Partial<typeof draft>) => {
    setDraft((prev) => {
      const merged = { ...prev, ...next };
      persist(merged);
      return merged;
    });
  };

  return (
    <section className="flex flex-col">
      <SectionHeader
        title="TypeSafe"
        description="Common-sense judgments are requested from TypeSafe. The key is encrypted at rest with everything else."
      />
      <div className="mt-1">
        <Row label="Credential" hint="Encrypted, revealed only on request.">
          <SecretField
            name="typesafe-apiKey"
            storedValue={draft.apiKey}
            onChange={(value) => patch({ apiKey: value })}
          />
        </Row>
        <Row label="Model" hint="TypeSafe model identifier.">
          <Input
            size="sm"
            value={draft.model}
            spellCheck={false}
            placeholder="system-one"
            className="font-mono"
            onChange={(event) => patch({ model: event.target.value })}
          />
        </Row>
        <Row
          label="Endpoint override"
          hint="Leave empty to use the same-origin /typesafe proxy."
        >
          <Input
            size="sm"
            value={draft.baseURL ?? ""}
            spellCheck={false}
            placeholder="https://api.typesafe.ai"
            className="font-mono"
            onChange={(event) => patch({ baseURL: event.target.value })}
          />
          <p className="text-xs leading-relaxed text-faint">
            TypeSafe sends no CORS headers, so the app calls it through a same-origin /typesafe proxy, included for dev
            and preview. A static host must proxy that path, or set an explicit endpoint here.
          </p>
        </Row>
      </div>
    </section>
  );
}

function LlmSection({ settings }: { settings: Settings }) {
  const update = useVaultStore((s) => s.update);
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState<ProviderConfig | null>(null);

  const providers = useMemo(() => settings.providers, [settings]);

  const startAdd = () => {
    if (adding) {
      setAdding(false);
      setNewProvider(null);
      return;
    }
    if (providers.length >= MAX_PROVIDERS) return;
    setNewProvider(emptyProvider());
    setAdding(true);
  };

  const saveProvider = async (next: ProviderConfig) => {
    const exists = providers.some((provider) => provider.id === next.id);
    const list = exists
      ? providers.map((provider) => (provider.id === next.id ? next : provider))
      : [...providers, next];
    await update({ providers: list });
    setAdding(false);
    setNewProvider(null);
  };

  const deleteProvider = async (id: string) => {
    await update({
      providers: providers.filter((provider) => provider.id !== id),
    });
  };

  return (
    <section className="flex flex-col">
      <SectionHeader
        title="LLM providers"
        description="OpenAI-compatible endpoints this app may call. A request only leaves the device when you run a query or test a connection."
        action={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={startAdd}
            disabled={providers.length >= MAX_PROVIDERS && !adding}
            icon={
              adding ? undefined : (
                <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
              )
            }
          >
            {adding ? "Cancel" : "Add provider"}
          </Button>
        }
      />

      <div className="mt-2">
        {adding && newProvider ? (
          <div className="mb-3 rounded-sm border border-accent-rule bg-surface px-2">
            <ProviderEntry
              provider={newProvider}
              startExpanded
              onSave={saveProvider}
              onDelete={async () => {
                setAdding(false);
                setNewProvider(null);
              }}
            />
          </div>
        ) : null}

        {providers.length > 0 ? (
          <div>
            {providers.map((provider) => (
              <ProviderEntry
                key={provider.id}
                provider={provider}
                onSave={saveProvider}
                onDelete={() => deleteProvider(provider.id)}
              />
            ))}
          </div>
        ) : null}

        {providers.length === 0 && !adding ? (
          <EmptyState
            icon={<Server size={18} strokeWidth={1.75} aria-hidden="true" />}
            title="No providers configured."
            hint="Add an OpenAI-compatible endpoint to send a query."
            action={
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={startAdd}
                icon={<Plus size={14} strokeWidth={1.75} aria-hidden="true" />}
              >
                Add provider
              </Button>
            }
          />
        ) : null}
      </div>
    </section>
  );
}

export function ProvidersPanel({
  section,
  onSectionChange,
}: {
  section: ProvidersSection;
  onSectionChange(section: ProvidersSection): void;
}) {
  const settings = useVaultStore((s) => s.settings);
  const baseId = useId();
  if (!settings) return null;

  const status: Record<ProvidersSection, string | null> = {
    llm: settings.providers.length > 0 ? String(settings.providers.length) : null,
    typesafe: settings.typesafe.apiKey.trim() !== "" ? "on" : null,
    playground: (() => {
      const count = Object.values(settings.playgroundProviders ?? {}).filter(
        (entry) => (entry?.apiKey ?? "").trim() !== "",
      ).length;
      return count > 0 ? String(count) : null;
    })(),
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = SECTIONS.indexOf(section);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % SECTIONS.length
        : (index - 1 + SECTIONS.length) % SECTIONS.length;
    onSectionChange(SECTIONS[next]);
    document.getElementById(`${baseId}-${SECTIONS[next]}-tab`)?.focus();
  };

  return (
    <div className="flex flex-col">
      <div
        role="tablist"
        aria-label="Provider type"
        onKeyDown={onKeyDown}
        className="sticky top-0 z-10 flex items-end gap-4 border-b border-rule bg-paper px-3"
      >
        {SECTIONS.map((entry) => (
          <button
            key={entry}
            id={`${baseId}-${entry}-tab`}
            type="button"
            role="tab"
            aria-selected={section === entry}
            aria-controls={`${baseId}-${entry}-panel`}
            tabIndex={section === entry ? 0 : -1}
            onClick={() => onSectionChange(entry)}
            className={`relative -mb-px flex items-baseline gap-1.5 border-b-2 py-2 text-sm transition-colors duration-150 ease-out-quart after:absolute after:-inset-x-1 after:inset-y-0 after:content-[''] ${
              section === entry
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:border-rule-strong hover:text-ink"
            }`}
          >
            {SECTION_LABEL[entry]}
            {status[entry] ? (
              <span className="numeric font-mono text-xs text-faint">{status[entry]}</span>
            ) : null}
          </button>
        ))}
      </div>
      {SECTIONS.map((entry) => (
        <div
          key={entry}
          id={`${baseId}-${entry}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-${entry}-tab`}
          hidden={section !== entry}
          className="px-3 py-3"
        >
          {entry === "llm" ? <LlmSection settings={settings} /> : null}
          {entry === "typesafe" ? <TypeSafeSection settings={settings} /> : null}
          {entry === "playground" ? <PlaygroundProvidersSection settings={settings} /> : null}
        </div>
      ))}
    </div>
  );
}

import { generateText } from "ai";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { createLLM } from "../ai/llm";
import { ModelManager } from "../ai/model-manager";
import type { ProviderValidationErrors } from "../ai/providers";
import { MAX_PROVIDERS, validateProvider } from "../ai/providers";
import { SecretField } from "../ai/secret-field";
import { Button, Input, Row } from "../ui/primitives";
import type { ProviderConfig, Settings } from "../vault/settings";
import { useVaultStore } from "../vault/store";

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

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

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
          <p className="truncate font-mono text-xs text-faint">{host}</p>
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
    <section className="mt-3 border-t border-rule pt-3">
      <SectionHeader
        title="TypeSafe"
        description="Common-sense judgments are requested from TypeSafe. The key is encrypted at rest with everything else. TypeSafe sends no CORS headers, so the app calls it through a same-origin /typesafe proxy (included for dev and preview); a static host must proxy that path or you can set an explicit endpoint below."
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
        </Row>
      </div>
    </section>
  );
}

export function ProvidersPanel() {
  const settings = useVaultStore((s) => s.settings);
  const update = useVaultStore((s) => s.update);
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState<ProviderConfig | null>(null);

  const providers = useMemo(() => settings?.providers ?? [], [settings]);

  if (!settings) return null;

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
    <section className="flex flex-col px-3 py-3">
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
          <p className="border-t border-rule py-6 text-xs text-muted">
            No providers configured. Add one to send a query.
          </p>
        ) : null}
      </div>

      <TypeSafeSection settings={settings} />
    </section>
  );
}

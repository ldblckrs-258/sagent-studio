import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SecretField } from "../ai/secret-field";
import type { ProviderDefinition } from "../playground/provider";
import { listProviders } from "../playground/registry";
import { Button, Input, Row } from "../ui/primitives";
import { VaultSettingsError } from "../vault/errors";
import { normalizePlaygroundBaseURL } from "../vault/settings";
import type { PlaygroundProviderSettings, Settings } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import { SectionHeader } from "./SectionHeader";

type CheckState = { status: "idle" | "checking" | "ok" | "error"; message?: string };

function ProviderTokenBlock({
  definition,
  stored,
}: {
  definition: ProviderDefinition;
  stored: PlaygroundProviderSettings | undefined;
}) {
  const setPlaygroundProvider = useVaultStore((s) => s.setPlaygroundProvider);
  const [draft, setDraft] = useState<PlaygroundProviderSettings>({
    apiKey: stored?.apiKey ?? "",
    baseURL: stored?.baseURL ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const persist = (next: PlaygroundProviderSettings) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const config = next.apiKey.trim() === "" ? null : next;
      setPlaygroundProvider(definition.id, config)
        .then(() => setError(null))
        .catch((caught: unknown) => {
          if (caught instanceof VaultSettingsError) setError(caught.message);
        });
    }, 400);
  };

  const patch = (next: Partial<PlaygroundProviderSettings>) => {
    setCheck({ status: "idle" });
    setDraft((prev) => {
      const merged = { ...prev, ...next };
      persist(merged);
      return merged;
    });
  };

  const checkToken = async () => {
    if (draft.apiKey.trim() === "") {
      setCheck({ status: "error", message: "Enter a token first." });
      return;
    }
    const baseURL = normalizePlaygroundBaseURL(draft.baseURL ?? "");
    if (baseURL === null) {
      setCheck({ status: "error", message: "Fix the base URL before checking the token." });
      return;
    }
    setCheck({ status: "checking" });
    try {
      const provider = definition.create({
        apiKey: draft.apiKey.trim(),
        baseURL: baseURL || definition.defaultBaseURL,
      });
      const { account } = await provider.verify();
      setCheck({ status: "ok", message: account ? `Token works for ${account}.` : "Token works." });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The token check failed.";
      setCheck({ status: "error", message: message.replaceAll(draft.apiKey, "***") });
    }
  };

  return (
    <article className="border-t border-rule py-2 first:border-t-0">
      <h3 className="text-sm font-medium text-ink">{definition.label}</h3>
      <Row label={definition.tokenLabel} hint="Stored encrypted. Leave empty to remove.">
        <SecretField
          name={`playground-${definition.id}-apiKey`}
          storedValue={draft.apiKey}
          onChange={(value) => patch({ apiKey: value })}
        />
        <a
          href={definition.tokenUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-accent underline-offset-2 hover:underline"
        >
          Get a token
        </a>
      </Row>
      <Row label="Base URL" hint={`Leave empty to use ${definition.defaultBaseURL}.`} error={error ?? undefined}>
        <Input
          size="sm"
          aria-label={`${definition.label} base URL`}
          value={draft.baseURL ?? ""}
          spellCheck={false}
          placeholder={definition.defaultBaseURL}
          className="font-mono"
          onChange={(event) => patch({ baseURL: event.target.value })}
        />
      </Row>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={check.status === "checking"}
          onClick={() => void checkToken()}
          icon={
            check.status === "checking" ? (
              <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" className="motion-safe:animate-spin" />
            ) : undefined
          }
        >
          Check token
        </Button>
        {check.message ? (
          <p
            role="status"
            className={`flex items-start gap-1.5 font-mono text-xs ${check.status === "ok" ? "text-positive" : "text-danger"}`}
          >
            {check.status === "ok" ? (
              <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            ) : (
              <CircleX size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            )}
            {check.message}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function PlaygroundProvidersSection({ settings }: { settings: Settings }) {
  return (
    <section className="flex flex-col">
      <SectionHeader
        title="Playground providers"
        description="Image models run in the Playground through these providers. Prompts, parameters, and input images go to the provider through a same-origin proxy path; a static host must proxy that path or you can set a base URL."
      />
      <div className="mt-1">
        {listProviders().map((definition) => (
          <ProviderTokenBlock
            key={definition.id}
            definition={definition}
            stored={settings.playgroundProviders?.[definition.id]}
          />
        ))}
      </div>
    </section>
  );
}

import { ArrowLeftRight, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import type { ProviderDefinition } from "../../playground/provider";
import type { PlaygroundModel, PlaygroundProviderId } from "../../playground/types";
import { Badge, Button, IconButton, Input, Row, Select } from "../primitives";

export function ModelPicker({
  providers,
  providerId,
  model,
  loading,
  error,
  disabled,
  onProviderChange,
  onResolve,
}: {
  providers: readonly ProviderDefinition[];
  providerId: PlaygroundProviderId;
  model: PlaygroundModel | null;
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  onProviderChange(id: PlaygroundProviderId): void;
  onResolve(slug: string): void;
}) {
  const definition = providers.find((entry) => entry.id === providerId) ?? providers[0];
  const [slug, setSlug] = useState(model?.slug ?? "");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [synced, setSynced] = useState(model?.slug ?? "");
  const [browsing, setBrowsing] = useState(false);

  if ((model?.slug ?? "") !== synced) {
    setSynced(model?.slug ?? "");
    setBrowsing(false);
    if (model) setSlug(model.slug);
  }

  const resolve = (next: string) => {
    const trimmed = next.trim();
    if (!definition.slugPattern.test(trimmed)) {
      setSlugError("Enter the model as owner/name.");
      return;
    }
    setSlugError(null);
    onResolve(trimmed);
  };

  const quickValue = definition.quickModels.includes(slug.trim()) ? slug.trim() : "";

  if (model && !browsing && !error) {
    return (
      <div className="flex items-start justify-between gap-3 py-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h2 className="min-w-0 truncate font-mono text-sm font-normal tracking-normal text-ink" title={model.slug}>
              {model.label}
            </h2>
            {model.editsImages ? <Badge tone="accent" size="sm">Edits images</Badge> : null}
          </div>
          {model.description ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-faint" title={model.description}>
              {model.description}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="quiet"
          disabled={disabled}
          onClick={() => setBrowsing(true)}
          icon={<ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden="true" />}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {model ? (
        <div className="flex items-center justify-between gap-2 pb-1">
          <span className="text-xs text-muted">
            Current <span className="font-mono text-ink">{model.label}</span>
          </span>
          {error ? null : (
            <IconButton label="Keep current model" onClick={() => setBrowsing(false)}>
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </IconButton>
          )}
        </div>
      ) : null}
      {providers.length > 1 ? (
        <Row label="Provider">
          <Select
            size="sm"
            aria-label="Provider"
            value={providerId}
            disabled={disabled}
            onChange={(event) => onProviderChange(event.target.value as PlaygroundProviderId)}
          >
            {providers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Row>
      ) : null}
      <Row label="Quick pick" hint={definition.label}>
        <Select
          size="sm"
          aria-label="Quick pick"
          value={quickValue}
          disabled={disabled}
          onChange={(event) => {
            if (!event.target.value) return;
            setSlug(event.target.value);
            resolve(event.target.value);
          }}
        >
          <option value="">Choose a model</option>
          {definition.quickModels.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Model" hint="owner/name" error={slugError ?? error ?? undefined}>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            resolve(slug);
          }}
        >
          <Input
            size="sm"
            aria-label="Model"
            value={slug}
            spellCheck={false}
            placeholder="black-forest-labs/flux-schnell"
            disabled={disabled}
            className="font-mono"
            onChange={(event) => setSlug(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={disabled || loading || slug.trim() === ""}
            icon={
              loading ? (
                <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" className="motion-safe:animate-spin" />
              ) : undefined
            }
          >
            Load
          </Button>
        </form>
      </Row>
    </div>
  );
}

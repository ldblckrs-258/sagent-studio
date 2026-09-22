import { FileText, Trash2, Upload } from "lucide-react";
import type { ChangeEvent, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useDocumentLibraryStore } from "../../rag/library-state";
import { useVaultStore } from "../../vault/store";
import {
  Badge,
  Button,
  Field,
  Input,
  PanelSection,
  Select,
} from "../primitives";
import { IngestProgressRow } from "./ingest-progress";

const ACCEPT = ".txt,.text,.md,.markdown,.pdf";

function kindLabel(kind: string): string {
  if (kind === "markdown") return "markdown";
  if (kind === "pdf") return "pdf";
  return "text";
}

export function LibraryPanel() {
  const documents = useDocumentLibraryStore((state) => state.documents);
  const status = useDocumentLibraryStore((state) => state.status);
  const progress = useDocumentLibraryStore((state) => state.progress);
  const error = useDocumentLibraryStore((state) => state.error);
  const addFiles = useDocumentLibraryStore((state) => state.addFiles);
  const remove = useDocumentLibraryStore((state) => state.remove);
  const refresh = useDocumentLibraryStore((state) => state.refresh);
  const reindex = useDocumentLibraryStore((state) => state.reindex);

  const rag = useVaultStore((state) => state.settings?.rag ?? null);
  const providers = useVaultStore((state) => state.settings?.providers ?? []);
  const typesafeKey = useVaultStore(
    (state) => state.settings?.typesafe.apiKey ?? "",
  );
  const update = useVaultStore((state) => state.update);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // The store is a module singleton, so load the list when the panel mounts and
  // after each unlock rather than waiting for a manual refresh.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pickedProvider =
    rag?.embedProviderId &&
    providers.some((provider) => provider.id === rag.embedProviderId)
      ? rag.embedProviderId
      : (providers[0]?.id ?? "");

  const providerModels =
    providers.find((provider) => provider.id === pickedProvider)?.models ?? [];
  // Prefer models the user flagged as embedding models in provider management;
  // fall back to the full list so a freshly added provider is still usable.
  const embeddingModels = providerModels.filter(
    (model) => model.caps?.embedding === true,
  );
  const modelOptions =
    embeddingModels.length > 0 ? embeddingModels : providerModels;
  const currentModelListed = modelOptions.some(
    (model) => model.id === rag?.embedModel,
  );

  function modelsFor(providerId: string): { id: string; name?: string }[] {
    const list =
      providers.find((provider) => provider.id === providerId)?.models ?? [];
    const flagged = list.filter((model) => model.caps?.embedding === true);
    return flagged.length > 0 ? flagged : list;
  }

  const missing =
    providers.length === 0
      ? "a provider with an embedding model"
      : !typesafeKey.trim()
        ? "a TypeSafe API key"
        : null;
  const busy = status === "ingesting";

  if (!rag) {
    return (
      <PanelSection
        label="Documents"
        hint="Unlock the vault to manage the document library."
      >
        <div className="px-2 py-4 text-xs text-faint">
          The library is available while the vault is unlocked.
        </div>
      </PanelSection>
    );
  }

  async function onPick(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length > 0) await addFiles(files);
  }

  async function onDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) await addFiles(files);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3">
      <PanelSection
        label="Documents"
        count={documents.length}
        action={
          <Button
            size="sm"
            variant="quiet"
            disabled={busy || missing !== null}
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={14} /> Add documents
          </Button>
        }
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => void onPick(event)}
        />
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => void onDrop(event)}
          className={`rounded-sm border border-dashed px-3 py-10 text-center text-xs ${
            dragging ? "border-accent text-accent" : "border-rule text-faint"
          }`}
        >
          Drop .txt, .md, or .pdf files here, or use Add documents.
        </div>

        {missing ? (
          <p className="rounded-sm border border-rule bg-surface px-2 py-2 text-xs leading-relaxed text-muted">
            Add {missing} in the Config panel before ingesting documents.
          </p>
        ) : null}

        {progress ? <IngestProgressRow progress={progress} /> : null}

        {error ? (
          <p
            role="alert"
            className="rounded-sm border border-danger-rule bg-danger-soft px-2 py-2 text-xs leading-relaxed text-danger"
          >
            {error}
          </p>
        ) : null}

        {documents.length === 0 ? (
          <div className="flex flex-col items-center gap-1 rounded-sm border border-dashed border-rule px-3 py-6 text-center">
            <FileText size={18} className="text-faint" />
            <span className="text-xs text-muted">No documents yet.</span>
            <span className="text-xs text-faint">
              Add a text, markdown, or PDF file to build your library.
            </span>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-rule-strong rounded-sm border border-rule">
            {documents.map((document) => (
              <li
                key={document.id}
                className="flex items-center gap-2 px-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-sm text-foreground"
                    title={document.title}
                  >
                    {document.title}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-faint">
                    <Badge>{kindLabel(document.kind)}</Badge>
                    <span className="numeric font-mono">
                      {document.chunkCount} chunks
                    </span>
                    <span className="numeric font-mono">
                      {document.dims}-dim
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Remove ${document.title}`}
                  disabled={busy}
                  onClick={() => void remove(document.id)}
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        label="Settings"
        hint="Embedding provider and retrieval parameters. Changes persist to the encrypted vault."
      >
        <Field label="Embedding provider">
          <Select
            size="sm"
            value={pickedProvider}
            disabled={providers.length === 0}
            onChange={(event) => {
              const providerId = event.target.value;
              const options = modelsFor(providerId);
              const keep = options.some((model) => model.id === rag.embedModel)
                ? rag.embedModel
                : (options[0]?.id ?? "");
              void update({
                rag: { embedProviderId: providerId, embedModel: keep },
              });
            }}
          >
            {providers.length === 0 ? (
              <option value="">No provider configured</option>
            ) : null}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label || provider.id}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Embedding model"
          error={
            providerModels.length === 0
              ? "This provider has no models. Fetch or add them in Config."
              : undefined
          }
        >
          <Select
            size="sm"
            value={rag.embedModel}
            disabled={modelOptions.length === 0}
            onChange={(event) =>
              void update({ rag: { embedModel: event.target.value } })
            }
          >
            {!currentModelListed && rag.embedModel ? (
              <option value={rag.embedModel}>
                {rag.embedModel} (not listed)
              </option>
            ) : null}
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name ?? model.id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Top-K passages">
          <Input
            size="sm"
            type="number"
            min={1}
            defaultValue={rag.topK}
            onBlur={(event) =>
              void update({
                rag: {
                  topK: Math.max(
                    1,
                    Math.trunc(Number(event.target.value) || rag.topK),
                  ),
                },
              })
            }
          />
        </Field>
        <Field label="Chunk size (tokens, 64-1024)">
          <Input
            size="sm"
            type="number"
            min={64}
            max={1024}
            defaultValue={rag.chunkSize}
            onBlur={(event) =>
              void update({
                rag: { chunkSize: Number(event.target.value) || rag.chunkSize },
              })
            }
          />
        </Field>
        <Field label="Overlap (tokens)">
          <Input
            size="sm"
            type="number"
            min={0}
            defaultValue={rag.overlap}
            onBlur={(event) =>
              void update({ rag: { overlap: Number(event.target.value) || 0 } })
            }
          />
        </Field>
        <Field label="Jev concurrency (1-8)">
          <Input
            size="sm"
            type="number"
            min={1}
            max={8}
            defaultValue={rag.concurrency}
            onBlur={(event) =>
              void update({
                rag: {
                  concurrency: Number(event.target.value) || rag.concurrency,
                },
              })
            }
          />
        </Field>
        <p className="text-xs leading-relaxed text-faint">
          Adding a document sends its chunk text to the selected embedding
          provider. A retrieval sends the query and the shortlisted passages to
          that provider and to TypeSafe. The index is encrypted at rest; listing
          and reading work offline, but a new query embedding needs the
          provider.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="quiet" onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={busy || documents.length === 0}
            title="Re-embed every document with the selected model. Required after changing the embedding model."
            onClick={() => void reindex()}
          >
            Re-index library
          </Button>
        </div>
      </PanelSection>
    </div>
  );
}

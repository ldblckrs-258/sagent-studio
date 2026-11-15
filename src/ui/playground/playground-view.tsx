import { ChevronsDownUp, ChevronsUpDown, FolderOpen, KeyRound, LoaderCircle, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  FormInputError,
  draftInput,
  editableInput,
  imageFields,
  initialValues,
  parseInputJson,
  toProviderInput,
  valuesFromInput,
} from "../../playground/form";
import type { FormValues } from "../../playground/form";
import { choosePlaygroundFolder, ensureFolderPermission, restorePlaygroundFolder, saveToFolder } from "../../playground/folder";
import type { PlaygroundProvider } from "../../playground/provider";
import { listProviders, providerFor } from "../../playground/registry";
import { groupRuns } from "../../playground/run-groups";
import { usePlaygroundStore } from "../../playground/state";
import type { InputImage } from "../../playground/state";
import { imageId } from "../../playground/store";
import type { OutputRef, RunMeta } from "../../playground/store";
import type { PlaygroundModel, PlaygroundProviderId } from "../../playground/types";
import { useVaultStore } from "../../vault/store";
import type { WorkspaceFs } from "../../workspace/fs";
import { EXTENSION_BY_MEDIA_TYPE } from "../composer-upload";
import { Button, EmptyState, IconButton } from "../primitives";
import { JsonInput } from "./json-input";
import { ModelPicker } from "./model-picker";
import { RunGallery } from "./run-gallery";
import type { RunActions, RunsView } from "./run-gallery";
import { SchemaForm } from "./schema-form";
import { SegmentedSwitch } from "./segmented-switch";
import type { FormErrorState, PendingImage } from "./schema-form";

type InputMode = "form" | "json";

interface FormState {
  model: PlaygroundModel;
  values: FormValues;
  images: Record<string, PendingImage[]>;
  json: string;
}

const RUN_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ Enter" : "Ctrl Enter";

function toJsonText(input: Record<string, unknown>): string {
  return JSON.stringify(input, null, 2);
}

const INPUT_MODES = [
  { value: "form", label: "Form" },
  { value: "json", label: "JSON" },
] as const;

const RUN_VIEWS = [
  { value: "list", label: "List" },
  { value: "gallery", label: "Gallery" },
] as const;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveStored(id: PlaygroundProviderId): PlaygroundProvider | null {
  return providerFor(id, useVaultStore.getState().settings?.playgroundProviders);
}

function outputFileName(run: RunMeta, output: OutputRef): string {
  const name = (run.model.split("/")[1] ?? "output").replace(/[^A-Za-z0-9._-]/g, "-");
  const extension =
    EXTENSION_BY_MEDIA_TYPE[output.mime] ?? (output.mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "");
  return `${name}-${run.id.slice(0, 8)}-${output.index}.${extension || "bin"}`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function PlaygroundView({ onOpenProviders }: { onOpenProviders(): void }) {
  const tokens = useVaultStore((s) => s.settings?.playgroundProviders);
  const skipped = usePlaygroundStore((s) => s.skipped);
  const hydrateError = usePlaygroundStore((s) => s.error);
  const runs = usePlaygroundStore((s) => s.runs);
  const groups = useMemo(() => groupRuns(runs), [runs]);
  const [runsView, setRunsView] = useState<RunsView>("list");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const available = useMemo(
    () => listProviders().filter((definition) => (tokens?.[definition.id]?.apiKey ?? "").trim() !== ""),
    [tokens],
  );
  const [chosenProvider, setChosenProvider] = useState<PlaygroundProviderId | null>(null);
  const providerId = available.some((entry) => entry.id === chosenProvider)
    ? (chosenProvider as PlaygroundProviderId)
    : (available[0]?.id ?? null);
  const provider = useMemo(() => (providerId ? providerFor(providerId, tokens) : null), [providerId, tokens]);

  const [form, setForm] = useState<FormState | null>(null);
  const [mode, setMode] = useState<InputMode>("form");
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormErrorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [folder, setFolder] = useState<WorkspaceFs | null>(null);

  useEffect(() => {
    void usePlaygroundStore.getState().hydrate(resolveStored);
    let cancelled = false;
    restorePlaygroundFolder()
      .then((restored) => {
        if (!cancelled) setFolder(restored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!providerId || !provider) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <EmptyState
            icon={<KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />}
            title="Add a provider token to use the Playground."
            hint="Tokens are stored encrypted in the vault and sent only to the provider."
            action={
              <Button type="button" size="sm" variant="primary" onClick={onOpenProviders}>
                Open Config → Providers
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const loadModel = async (target: PlaygroundProvider, slug: string): Promise<PlaygroundModel | null> => {
    setModelLoading(true);
    setModelError(null);
    try {
      return await usePlaygroundStore.getState().resolveModel(target, slug);
    } catch (error) {
      setModelError(describe(error));
      return null;
    } finally {
      setModelLoading(false);
    }
  };

  const onResolve = async (slug: string) => {
    const model = await loadModel(provider, slug);
    if (!model) return;
    setFormError(null);
    setModeNotice(null);
    const values = initialValues(model.fields);
    setForm({ model, values, images: {}, json: toJsonText(draftInput(model.fields, values)) });
  };

  const switchMode = (next: InputMode) => {
    if (!form || next === mode) return;
    setFormError(null);
    setModeNotice(null);
    if (next === "json") {
      setForm({ ...form, json: toJsonText(draftInput(form.model.fields, form.values)) });
      setMode("json");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseInputJson(form.json);
    } catch (error) {
      setFormError({ message: `${describe(error)} Fix it before switching to Form.` });
      return;
    }
    const { values, dropped } = valuesFromInput(form.model.fields, parsed);
    setForm({ ...form, values });
    setMode("form");
    if (dropped.length > 0) {
      setModeNotice(`The form has no control for ${dropped.join(", ")}, so ${dropped.length === 1 ? "it was" : "they were"} left out.`);
    }
  };

  const run = async (target: PlaygroundProvider, state: FormState, inputMode: InputMode) => {
    setFormError(null);
    setSubmitting(true);
    try {
      const raw = inputMode === "json" ? parseInputJson(state.json) : null;
      const values: FormValues = raw ?? { ...state.values };
      const inputImages: InputImage[] = [];
      for (const field of imageFields(state.model.fields)) {
        const pending = state.images[field.name] ?? [];
        if (pending.length === 0) continue;
        if (raw && Object.hasOwn(raw, field.name)) continue;
        const selected = field.kind === "image" ? pending.slice(0, 1) : pending;
        const uris: string[] = [];
        for (const image of selected) {
          uris.push(await target.prepareImage(image.blob, image.name));
          inputImages.push({ field: field.name, name: image.name, blob: image.blob });
        }
        values[field.name] = field.kind === "image" ? uris[0] : uris;
      }
      const input = raw ?? toProviderInput(state.model.fields, values);
      await usePlaygroundStore.getState().start({
        provider: target,
        model: state.model,
        input,
        fields: state.model.fields,
        inputImages,
      });
    } catch (error) {
      setFormError(
        error instanceof FormInputError ? { field: error.field, message: error.message } : { message: describe(error) },
      );
    } finally {
      setSubmitting(false);
    }
  };

  const loadRun = async (stored: RunMeta): Promise<{ target: PlaygroundProvider; state: FormState } | null> => {
    setNotice(null);
    const target = providerFor(stored.providerId, tokens);
    if (!target) {
      setNotice("Add a token for this run's provider in Config → Providers first.");
      return null;
    }
    setChosenProvider(stored.providerId);
    const model = await loadModel(target, stored.model);
    if (!model) return null;
    const images: Record<string, PendingImage[]> = {};
    try {
      for (const image of stored.inputImages) {
        const blob = await usePlaygroundStore
          .getState()
          .loadImageBlob(imageId(stored.id, "input", image.index), image.mime);
        (images[image.field] ??= []).push({ id: crypto.randomUUID(), name: image.name, blob });
      }
    } catch (error) {
      setNotice(`The stored input images could not be read. ${describe(error)}`);
    }
    const state: FormState = {
      model,
      values: valuesFromInput(model.fields, stored.input).values,
      images,
      json: toJsonText(editableInput(model.fields, stored.input)),
    };
    setModeNotice(null);
    setFormError(
      stored.secretFields.length === 0
        ? null
        : mode === "json"
          ? { message: `Add ${stored.secretFields.join(", ")} again; secrets are never saved.` }
          : { field: stored.secretFields[0], message: "Enter this secret again; it was never saved." },
    );
    setForm(state);
    return { target, state };
  };

  const actions: RunActions = {
    onUseSettings: (stored) => void loadRun(stored),
    onRerun: (stored) =>
      void loadRun(stored).then((loaded) => {
        if (loaded && stored.secretFields.length === 0) return run(loaded.target, loaded.state, mode);
      }),
    onDownload: (stored, output) =>
      void usePlaygroundStore
        .getState()
        .loadImageBlob(imageId(stored.id, "output", output.index), output.mime)
        .then((blob) => downloadBlob(blob, outputFileName(stored, output)))
        .catch((error: unknown) => setNotice(describe(error))),
    onSaveToFolder: (stored, output) =>
      void (async () => {
        setNotice(null);
        try {
          const target = folder ?? (await choosePlaygroundFolder());
          await ensureFolderPermission(target);
          setFolder(target);
          const blob = await usePlaygroundStore
            .getState()
            .loadImageBlob(imageId(stored.id, "output", output.index), output.mime);
          const path = await saveToFolder(target, outputFileName(stored, output), blob);
          setNotice(`Saved ${path} to ${target.handle.name}.`);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setNotice(describe(error));
        }
      })(),
    onRetryDownload: (stored) => {
      setNotice(null);
      const target = providerFor(stored.providerId, tokens);
      if (!target) {
        setNotice("Add a token for this run's provider in Config → Providers first.");
        return;
      }
      usePlaygroundStore
        .getState()
        .retryDownload(stored.id, target)
        .catch((error: unknown) => setNotice(describe(error)));
    },
  };

  const changeFolder = async () => {
    try {
      setFolder(await choosePlaygroundFolder());
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setNotice(describe(error));
    }
  };

  const owner = form?.model.slug.split("/")[0] ?? "";
  const uploadsFor = form
    ? imageFields(form.model.fields)
        .filter((field) => (form.images[field.name] ?? []).length > 0)
        .map((field) => field.name)
    : [];

  const allCollapsed = groups.length > 0 && groups.every((group) => collapsed.has(group.key));
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const generalError = formError && (mode === "json" || !formError.field) ? formError.message : null;

  return (
    <div className="h-full overflow-y-auto lg:grid lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] lg:overflow-hidden">
      <section
        aria-label="Playground form"
        className="flex flex-col border-b border-rule lg:h-full lg:overflow-y-auto lg:border-b-0 lg:border-r"
      >
        <div className="px-4 pt-3">
          <ModelPicker
            providers={available}
            providerId={providerId}
            model={form?.model ?? null}
            loading={modelLoading}
            error={modelError}
            disabled={submitting}
            onProviderChange={(id) => {
              setChosenProvider(id);
              setForm(null);
            }}
            onResolve={(slug) => void onResolve(slug)}
          />
        </div>
        {form ? (
          <form
            className="flex flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!submitting) void run(provider, form, mode);
            }}
            onKeyDownCapture={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
              event.preventDefault();
              event.stopPropagation();
              if (!submitting) void run(provider, form, mode);
            }}
          >
            <div className="flex-1 px-4 pb-4">
              <div className="flex items-center justify-between gap-2 border-t border-rule pb-1 pt-3">
                <span className="label-micro">Input</span>
                <SegmentedSwitch label="Input mode" value={mode} options={INPUT_MODES} onChange={switchMode} />
              </div>
              {modeNotice ? (
                <p role="status" className="py-1 text-xs text-caution">
                  {modeNotice}
                </p>
              ) : null}
              {mode === "json" ? (
                <JsonInput
                  value={form.json}
                  imageFieldsWithUploads={uploadsFor}
                  onChange={(json) => setForm((prev) => (prev ? { ...prev, json } : prev))}
                />
              ) : (
                <SchemaForm
                  fields={form.model.fields}
                  values={form.values}
                  images={form.images}
                  owner={owner}
                  error={formError}
                  disabled={submitting}
                  onValueChange={(name, value) =>
                    setForm((prev) => (prev ? { ...prev, values: { ...prev.values, [name]: value } } : prev))
                  }
                  onImagesChange={(name, images) =>
                    setForm((prev) => (prev ? { ...prev, images: { ...prev.images, [name]: images } } : prev))
                  }
                />
              )}
            </div>
            <div className="sticky bottom-0 flex flex-col gap-2 border-t border-rule bg-paper px-4 py-3">
              {generalError ? (
                <p role="alert" className="font-mono text-xs text-danger">
                  {generalError}
                </p>
              ) : null}
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  disabled={submitting}
                  className="flex-1"
                  icon={
                    submitting ? (
                      <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" className="motion-safe:animate-spin" />
                    ) : (
                      <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                    )
                  }
                >
                  Run
                </Button>
                <kbd className="shrink-0 font-mono text-xs text-faint">{RUN_SHORTCUT}</kbd>
              </div>
            </div>
          </form>
        ) : (
          <p className="px-4 pb-4 text-xs leading-relaxed text-faint">
            Pick a suggested model or enter any public model as owner/name. Its input form is built from the model&apos;s
            published schema.
          </p>
        )}
      </section>
      <section aria-label="Playground runs" className="lg:h-full lg:overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="flex items-baseline gap-1.5">
              <span className="label-micro">Runs</span>
              <span className="numeric font-mono text-xs text-faint">{runs.length}</span>
            </span>
            <SegmentedSwitch<RunsView> label="Runs view" value={runsView} options={RUN_VIEWS} onChange={setRunsView} />
            {runsView === "list" && groups.length > 0 ? (
              <IconButton
                label={allCollapsed ? "Expand all" : "Collapse all"}
                onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((group) => group.key)))}
              >
                {allCollapsed ? (
                  <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <ChevronsDownUp size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
              </IconButton>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="quiet"
            onClick={() => void changeFolder()}
            icon={<FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />}
          >
            {folder ? `Folder: ${folder.handle.name}` : "Choose save folder"}
          </Button>
        </div>
        <div className="px-4 py-3">
          {skipped > 0 ? (
            <p role="status" className="mb-2 text-xs text-caution">
              {skipped === 1 ? "1 run could not be read." : `${skipped} runs could not be read.`}
            </p>
          ) : null}
          {hydrateError ? (
            <p role="alert" className="mb-2 font-mono text-xs text-danger">
              {hydrateError}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mb-2 text-xs text-muted">
              {notice}
            </p>
          ) : null}
          <RunGallery
            view={runsView}
            runs={runs}
            groups={groups}
            collapsed={collapsed}
            onToggle={toggleGroup}
            folderName={folder?.handle.name ?? null}
            actions={actions}
          />
        </div>
      </section>
    </div>
  );
}

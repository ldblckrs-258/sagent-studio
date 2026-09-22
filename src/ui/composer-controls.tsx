import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  PenLine,
  Plus,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useRef, useState } from "react";
import { modelSupportsVision } from "../ai/model-caps";
import { ensureActiveThread } from "../chat/active-thread";
import { composerThreadKey } from "../chat/attachment-store";
import { isImagePath } from "../chat/attachments";
import { useChatStore } from "../chat/store";
import {
  DEFAULT_CHAT_MODE,
  defaultProviderFor,
  patchThreadConfig,
  patchThreadMode,
} from "../chat/threads";
import type { ChatMode, SkillRef, ThreadConfig } from "../chat/types";
import { useSession } from "../session/session-context";
import { useWorkspaceStore } from "../session/workspace-state";
import type { WorkspaceFs } from "../workspace/fs";
import { UPLOAD_DIRECTORY, uploadFiles } from "./composer-upload";
import { WorkspacePermissionError } from "../workspace/errors";
import type { ProviderConfig } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import { useRegistryVersion } from "./use-registry-version";

const TRIGGER =
  "relative inline-flex h-7 max-w-40 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-paper-sunk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-rule disabled:cursor-not-allowed disabled:opacity-45";

const ITEM =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-paper-sunk disabled:cursor-not-allowed disabled:opacity-45";

const CONTENT =
  "z-50 w-72 rounded-sm border border-rule-strong bg-surface shadow-[0_1px_2px_oklch(0.22_0.02_264/0.05),0_12px_28px_-8px_oklch(0.22_0.02_264/0.16)] outline-none";

/**
 * The permission modes are an escalation ladder, so the control names the rung
 * you are on: the trigger carries the active mode's icon and tint, and the menu
 * spells the ladder out. Each tint is a token already owned by the app: teal is
 * the brand accent, amber is the app's caution tone, and read-only stays neutral.
 */
const MODE_OPTIONS: {
  value: ChatMode;
  label: string;
  description: string;
  icon: typeof Eye;
  iconSize?: number;
  menuIconSize?: number;
  tint: { trigger: string; icon: string; label: string };
}[] = [
  {
    value: "read_only",
    label: "Read only",
    description: "Inspect and search. Every change asks first.",
    icon: Eye,
    tint: {
      trigger: "text-muted-foreground hover:text-foreground",
      icon: "border-rule bg-paper-sunk text-muted",
      label: "text-ink",
    },
  },
  {
    value: "editing",
    label: "Editing",
    description: "Write files and run code. Destructive actions ask first.",
    icon: PenLine,
    iconSize: 11,
    menuIconSize: 12,
    tint: {
      trigger: "text-accent hover:text-accent-hover",
      icon: "border-accent-rule bg-accent-soft text-accent",
      label: "text-accent",
    },
  },
  {
    value: "god",
    label: "God",
    description: "Auto-approve every gated action.",
    icon: Zap,
    tint: {
      trigger: "text-caution hover:text-caution",
      icon: "border-caution-rule bg-caution-soft text-caution",
      label: "text-caution",
    },
  },
];

function sameSkill(a: SkillRef, b: SkillRef): boolean {
  return a.id === b.id && a.source === b.source;
}

function providerHost(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL || "not set";
  }
}

type Level = { kind: "providers" } | { kind: "models"; providerId: string };

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange(value: string): void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        size={13}
        strokeWidth={1.75}
        aria-hidden="true"
        className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-faint"
      />
      <input
        value={value}
        autoFocus
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-7 w-full bg-transparent pl-6 pr-1 text-xs text-ink outline-none placeholder:text-faint"
      />
    </div>
  );
}

function ModelPickerBody({
  providers,
  providerId,
  modelId,
  saving,
  onSelect,
}: {
  providers: readonly ProviderConfig[];
  providerId: string | undefined;
  modelId: string | undefined;
  saving: boolean;
  onSelect(providerId: string, modelId: string | undefined): void;
}) {
  const [level, setLevel] = useState<Level>(() =>
    providers.length === 1
      ? { kind: "models", providerId: providers[0].id }
      : { kind: "providers" },
  );
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const activeProvider =
    level.kind === "models"
      ? providers.find((provider) => provider.id === level.providerId)
      : undefined;

  const goToModels = (nextProviderId: string) => {
    setLevel({ kind: "models", providerId: nextProviderId });
    setQuery("");
  };

  return (
    <>
      <div className="flex items-center gap-1 border-b border-rule px-1.5 py-1">
        {level.kind === "models" ? (
          <button
            type="button"
            aria-label="Back to providers"
            title="Back to providers"
            onClick={() => {
              setLevel({ kind: "providers" });
              setQuery("");
            }}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-paper-sunk hover:text-ink"
          >
            <ChevronLeft size={14} strokeWidth={1.75} />
          </button>
        ) : null}
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={
            level.kind === "providers" ? "Search providers" : "Search models"
          }
        />
      </div>

      <div className="flex max-h-64 flex-col overflow-y-auto p-1">
        {level.kind === "providers" ? (
          providers
            .filter((provider) =>
              `${provider.label} ${providerHost(provider.baseURL)} ${provider.id}`
                .toLowerCase()
                .includes(needle),
            )
            .map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => goToModels(provider.id)}
                className={ITEM}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">
                    {provider.label || "Untitled provider"}
                  </span>
                  <span className="block truncate font-mono text-faint">
                    {providerHost(provider.baseURL)}
                  </span>
                </span>
                <span className="numeric shrink-0 font-mono text-faint">
                  {provider.models.length}
                </span>
                <ChevronRight
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0 text-faint"
                />
              </button>
            ))
        ) : (
          <>
            {activeProvider ? (
              <p className="label-micro px-2 py-1">
                {activeProvider.label || "Provider"}
              </p>
            ) : null}
            {(activeProvider
              ? [undefined, ...activeProvider.models.map((model) => model.id)]
              : [undefined]
            )
              .filter((model) =>
                (model ?? "default model").toLowerCase().includes(needle),
              )
              .map((model) => {
                const selected =
                  activeProvider !== undefined &&
                  activeProvider.id === providerId &&
                  (model ?? undefined) === modelId;
                return (
                  <button
                    key={model ?? "__default"}
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      if (activeProvider) onSelect(activeProvider.id, model);
                    }}
                    className={ITEM}
                  >
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono",
                        selected ? "text-accent" : "text-ink",
                      )}
                    >
                      {model ?? "Default model"}
                    </span>
                    {selected ? (
                      <Check
                        size={13}
                        strokeWidth={2}
                        className="shrink-0 text-accent"
                      />
                    ) : null}
                  </button>
                );
              })}
          </>
        )}
      </div>
    </>
  );
}

type SkillOption = { id: string; name: string; source: SkillRef["source"] };

function SkillsPickerBody({
  skills,
  attached,
  saving,
  onSetAttached,
  onToggle,
}: {
  skills: readonly SkillOption[];
  attached: readonly SkillRef[];
  saving: boolean;
  onSetAttached(next: SkillRef[]): void;
  onToggle(ref: SkillRef, checked: boolean): void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = skills.filter((skill) =>
    `${skill.name} ${skill.id} ${skill.source}`.toLowerCase().includes(needle),
  );
  const isAttached = (ref: SkillRef) =>
    attached.some((entry) => sameSkill(entry, ref));
  const allAttached =
    skills.length > 0 &&
    skills.every((skill) => isAttached({ id: skill.id, source: skill.source }));
  const noneAttached = attached.length === 0;

  const attachAll = () => {
    const next = [...attached];
    for (const skill of skills) {
      const ref: SkillRef = { id: skill.id, source: skill.source };
      if (!next.some((entry) => sameSkill(entry, ref))) next.push(ref);
    }
    onSetAttached(next);
  };

  return (
    <>
      <div className="flex items-center gap-1 border-b border-rule px-1.5 py-1">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search skills"
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-rule px-2 py-1.5">
        <span className="label-micro">{skills.length} available</span>
        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            disabled={allAttached || saving}
            onClick={attachAll}
            className="rounded-sm px-1.5 py-0.5 text-accent transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-rule disabled:cursor-not-allowed disabled:opacity-45"
          >
            Attach all
          </button>
          <button
            type="button"
            disabled={noneAttached || saving}
            onClick={() => onSetAttached([])}
            className="rounded-sm px-1.5 py-0.5 text-muted transition-colors hover:bg-paper-sunk hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-rule disabled:cursor-not-allowed disabled:opacity-45"
          >
            Detach all
          </button>
        </div>
      </div>
      <div className="flex max-h-64 flex-col overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-faint">
            No skills match.
          </p>
        ) : (
          filtered.map((skill) => {
            const ref: SkillRef = { id: skill.id, source: skill.source };
            const checked = isAttached(ref);
            return (
              <label
                key={`${skill.source}:${skill.id}`}
                className={cn(ITEM, "cursor-pointer")}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={saving}
                  onChange={(event) => onToggle(ref, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate text-ink">
                  {skill.name}
                </span>
                <span className="label-micro shrink-0">{skill.source}</span>
              </label>
            );
          })
        )}
      </div>
    </>
  );
}

/**
 * Composer-level model and skills controls. Both write the active thread's
 * config, creating the conversation on first use so a picker is never dead
 * before the first message. Skills here can only toggle ones already enabled
 * globally; the registry filters out the rest, and the Skills panel owns that
 * trust decision.
 */
/**
 * The upload button.
 *
 * Gated on a `readwrite` permission **query**, not on `status === 'ready'`:
 * the workspace store establishes `ready` from a read query, so a handle
 * restored after a reload can be readable and still refuse a write. The
 * tooltip names the destination directory, because uploading works in every
 * chat mode — including `read_only`, whose menu text promises that every
 * change asks first — so the write must never be silent.
 */
async function queryWritable(fs: WorkspaceFs): Promise<boolean> {
  const query = fs.handle.queryPermission;
  if (typeof query !== "function") return true;
  try {
    return (await query.call(fs.handle, { mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

function UploadButton({ vision }: { vision: boolean }) {
  const fs = useWorkspaceStore((s) => s.fs);
  const regrant = useWorkspaceStore((s) => s.regrant);
  // Refreshed from pointer and focus, never from an effect: the answer only
  // matters when the button is about to be used, and the click itself has to
  // stay synchronous or the file picker loses its user gesture.
  const [writable, setWritable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    if (!fs) {
      setWritable(null);
      return;
    }
    void queryWritable(fs).then(setWritable);
  };

  const onPicked = async (files: FileList | null) => {
    if (!fs || !files || files.length === 0) return;
    const picked = Array.from(files);
    // A non-vision model gets no image bytes; the text files in the same pick
    // still upload, so one rejected image never costs the whole batch.
    const allowed = vision ? picked : picked.filter((file) => !isImagePath(file.name));
    const skipped = picked.length - allowed.length;
    const skippedMessage =
      skipped === 0
        ? null
        : `${skipped} image ${
            skipped === 1 ? "file was" : "files were"
          } skipped: the active model has no image input.`;
    if (allowed.length === 0) {
      useChatStore.getState().setError(skippedMessage);
      return;
    }
    setBusy(true);
    try {
      await uploadFiles(fs, composerThreadKey(), allowed);
      useChatStore.getState().setError(skippedMessage);
    } catch (cause) {
      if (cause instanceof WorkspacePermissionError) {
        setWritable(false);
        useChatStore
          .getState()
          .setError("Grant write access to the workspace folder to upload files.");
        void regrant();
      } else {
        useChatStore
          .getState()
          .setError(
            cause instanceof Error ? cause.message : "The upload failed.",
          );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          void onPicked(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy || fs === null}
        onPointerEnter={refresh}
        onFocus={refresh}
        onClick={() => {
          if (writable === false) {
            void regrant();
            return;
          }
          inputRef.current?.click();
        }}
        className={cn(TRIGGER, "text-muted-foreground hover:text-foreground")}
        title={
          fs === null
            ? "Choose a workspace folder to upload files"
            : writable === false
              ? `Grant write access to upload into ${UPLOAD_DIRECTORY}/`
              : `Upload files into ${UPLOAD_DIRECTORY}/ and attach them`
        }
        aria-label="Upload files"
      >
        <Plus size={13} strokeWidth={1.75} className="shrink-0" />
      </button>
    </>
  );
}

export function ComposerControls() {
  const session = useSession();
  // Skills hydrate asynchronously after mount, so the composer must re-render
  // when the registry mutates or the picker stays stuck on its empty state.
  useRegistryVersion(session.skillRegistry);
  const settings = useVaultStore((s) => s.settings);
  const providers = settings?.providers ?? [];
  const config = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.config : undefined,
  );
  const mode =
    useChatStore((s) =>
      s.activeThreadId ? s.threads[s.activeThreadId]?.mode : undefined,
    ) ?? DEFAULT_CHAT_MODE;
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const fallback = defaultProviderFor(settings);
  const providerId = config?.providerId ?? fallback?.providerId;
  const modelId = config?.modelId ?? fallback?.modelId;
  const selectedProvider = providers.find(
    (provider) => provider.id === providerId,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.id === modelId,
  );
  const modelLabel =
    selectedModel?.name ??
    (modelId ?? selectedProvider?.defaultModel ?? selectedProvider?.label)
      ?.split("/")
      ?.pop()
      ?.replaceAll("-", " ") ??
    "No model";
  const vision = modelSupportsVision(settings, providerId, modelId);
  const activeMode =
    MODE_OPTIONS.find((option) => option.value === mode) ?? MODE_OPTIONS[1];
  const ActiveModeIcon = activeMode.icon;

  const availableSkills = session.skillRegistry
    .list()
    .filter((skill) =>
      session.skillRegistry.isEnabled({ id: skill.id, source: skill.source }),
    );
  const enabledSkills = config?.enabledSkills ?? [];

  const applyConfig = async (patch: Partial<ThreadConfig>) => {
    setSaving(true);
    try {
      const id = await ensureActiveThread(session);
      if (!id) return;
      const thread = useChatStore.getState().threads[id];
      if (!thread) return;
      const next = patchThreadConfig(thread, patch);
      useChatStore.getState().setThread(next);
      await session.threadStore.saveThread(next);
      useChatStore.getState().setError(null);
    } catch (cause) {
      useChatStore
        .getState()
        .setError(
          cause instanceof Error
            ? cause.message
            : "The change could not be saved.",
        );
    } finally {
      setSaving(false);
    }
  };

  const applyMode = async (next: ChatMode) => {
    setSaving(true);
    try {
      const id = await ensureActiveThread(session);
      if (!id) return;
      const thread = useChatStore.getState().threads[id];
      if (!thread) return;
      const updated = patchThreadMode(thread, next);
      useChatStore.getState().setThread(updated);
      await session.threadStore.saveThread(updated);
      useChatStore.getState().setError(null);
    } catch (cause) {
      useChatStore
        .getState()
        .setError(
          cause instanceof Error
            ? cause.message
            : "The change could not be saved.",
        );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-1" data-composer-controls>
      <UploadButton vision={vision} />
      <PopoverPrimitive.Root open={modeOpen} onOpenChange={setModeOpen}>
        <PopoverPrimitive.Trigger
          type="button"
          className={cn(TRIGGER, activeMode.tint.trigger)}
          disabled={saving}
          title="Permission mode for this conversation"
          aria-label={`Permission mode: ${activeMode.label}`}
        >
          <ActiveModeIcon
            size={activeMode.iconSize ?? 13}
            strokeWidth={1.75}
            className="shrink-0"
          />
          <span className="min-w-0 truncate font-mono">{activeMode.label}</span>
          <ChevronDown size={12} strokeWidth={1.75} className="shrink-0" />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="start"
            sideOffset={8}
            className={CONTENT}
          >
            <p className="label-micro border-b border-rule px-2.5 py-1.5">
              Permission mode
            </p>
            <div className="flex flex-col p-1">
              {MODE_OPTIONS.map((option) => {
                const Icon = option.icon;
                const selected = option.value === mode;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={saving}
                    aria-pressed={selected}
                    onClick={() => {
                      setModeOpen(false);
                      if (!selected) void applyMode(option.value);
                    }}
                    className={cn(
                      ITEM,
                      "items-start gap-2.5 px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-rule",
                      selected && "bg-paper-sunk",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-md border",
                        option.tint.icon,
                      )}
                    >
                      <Icon
                        size={option.menuIconSize ?? 14}
                        strokeWidth={1.75}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block",
                          selected ? option.tint.label : "text-ink",
                        )}
                      >
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-faint">
                        {option.description}
                      </span>
                    </span>
                    {selected ? (
                      <Check
                        size={13}
                        strokeWidth={2}
                        className={cn("mt-1 shrink-0", option.tint.label)}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <PopoverPrimitive.Root open={modelOpen} onOpenChange={setModelOpen}>
        <PopoverPrimitive.Trigger
          type="button"
          className={cn(
            TRIGGER,
            "text-muted-foreground hover:text-foreground max-w-50",
          )}
          disabled={providers.length === 0}
          title={
            providers.length === 0
              ? "Configure a provider in Config"
              : "Change model"
          }
          aria-label="Change model"
        >
          <span className="min-w-0 truncate font-mono capitalize">
            {modelLabel}
          </span>
          <ChevronDown size={12} strokeWidth={1.75} className="shrink-0" />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="start"
            sideOffset={8}
            className={CONTENT}
          >
            <ModelPickerBody
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              saving={saving}
              onSelect={(nextProviderId, nextModelId) => {
                void applyConfig({
                  providerId: nextProviderId,
                  modelId: nextModelId,
                });
                setModelOpen(false);
              }}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger
          type="button"
          className={cn(TRIGGER, "text-muted-foreground hover:text-foreground")}
          title="Skills for this conversation"
          aria-label="Skills for this conversation"
        >
          <Sparkles size={13} strokeWidth={1.75} className="shrink-0" />
          {enabledSkills.length > 0 ? (
            <span className="numeric font-mono">{enabledSkills.length}</span>
          ) : null}
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="start"
            sideOffset={8}
            className={CONTENT}
          >
            {availableSkills.length === 0 && enabledSkills.length === 0 ? (
              <p className="px-2 py-2 text-xs leading-relaxed text-muted">
                No skills are enabled. Turn them on in the Skills panel first.
              </p>
            ) : (
              <SkillsPickerBody
                skills={availableSkills}
                attached={enabledSkills}
                saving={saving}
                onSetAttached={(next) =>
                  void applyConfig({ enabledSkills: next })
                }
                onToggle={(ref, checked) => {
                  const next = checked
                    ? [...enabledSkills, ref]
                    : enabledSkills.filter((entry) => !sameSkill(entry, ref));
                  void applyConfig({ enabledSkills: next });
                }}
              />
            )}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}

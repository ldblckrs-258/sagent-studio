import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  BookOpen,
  Bot,
  Boxes,
  FileText,
  FolderTree,
  Lock as LockIcon,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type {
  ComponentType,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
import { agentRunStore } from "../agents/store";
import { listThreadSummaries } from "../chat/persistence";
import { rehydrateThread } from "../chat/sanitize";
import { useChatStore } from "../chat/store";
import { useChatRuntime } from "../chat/use-chat-runtime";
import { Thread } from "../components/assistant-ui/elements/thread.aui";
import { useMediaQuery } from "../hooks/use-media-query";
import { useFileViewStore } from "../session/file-view-state";
import { useSession } from "../session/session-context";
import { useVaultStore } from "../vault/store";
import { AgentsPanel } from "./panels/agents";
import { ApprovalsPanel } from "./panels/approvals";
import type { ConfigTab } from "./panels/chat-config";
import { ChatConfig } from "./panels/chat-config";
import { Conversations } from "./panels/conversations";
import { FilePanel } from "./panels/file-editor";
import { LibraryPanel } from "./panels/library";
import { SandboxPanel } from "./panels/sandbox";
import { SkillsPanel } from "./panels/skills";
import { ToolsPanel } from "./panels/tools";
import { WorkspacePanel } from "./panels/workspace";
import { PlanPanel } from "./plan-panel";
import { Button } from "./primitives";
import { PANEL_DEFAULT_WIDTH, clampPanelWidth, panelWidthMax } from "./resize";
import { ResizeHandle } from "./resize-handle";
import { useRegistryVersion } from "./use-registry-version";

export type RailPanelId =
  | "config"
  | "workspace"
  | "files"
  | "documents"
  | "skills"
  | "tools"
  | "sandbox"
  | "agents"
  | "approvals";

const RAIL_IDS: readonly RailPanelId[] = [
  "config",
  "workspace",
  "files",
  "documents",
  "skills",
  "tools",
  "sandbox",
  "agents",
  "approvals",
];

interface RailPanelState {
  open: boolean;
  activePanel: RailPanelId;
  width: number;
}

interface RailPanelDef {
  id: RailPanelId;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  render(): ReactNode;
}

const RAIL_STATE_KEY = "sagent.rail.v2";
const SIDEBAR_STATE_KEY = "sagent.sidebar.v1";
const DEFAULT_RAIL: RailPanelState = {
  open: false,
  activePanel: "config",
  width: PANEL_DEFAULT_WIDTH,
};

function readSidebarCollapsed(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(SIDEBAR_STATE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function readRailState(): RailPanelState {
  if (typeof sessionStorage === "undefined") return DEFAULT_RAIL;
  try {
    const raw = sessionStorage.getItem(RAIL_STATE_KEY);
    if (!raw) return DEFAULT_RAIL;
    const parsed = JSON.parse(raw) as Partial<RailPanelState>;
    const activePanel =
      typeof parsed.activePanel === "string" &&
      (RAIL_IDS as readonly string[]).includes(parsed.activePanel)
        ? (parsed.activePanel as RailPanelId)
        : DEFAULT_RAIL.activePanel;
    const width =
      typeof parsed.width === "number" && Number.isFinite(parsed.width)
        ? parsed.width
        : DEFAULT_RAIL.width;
    return { open: parsed.open === true, activePanel, width };
  } catch {
    return DEFAULT_RAIL;
  }
}

function RailButton({
  id,
  label,
  icon: Icon,
  active,
  badge,
  onClick,
}: {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  active: boolean;
  badge?: number;
  onClick(event: ReactMouseEvent<HTMLButtonElement>): void;
}) {
  const labelWithBadge = badge && badge > 0 ? `${label} (${badge} pending)` : label;
  return (
    <button
      type="button"
      data-rail-button={id}
      aria-label={labelWithBadge}
      aria-expanded={active}
      title={labelWithBadge}
      onClick={onClick}
      className={`relative inline-flex size-9 items-center justify-center rounded-sm border transition-colors duration-150 ease-out-quart ${
        active
          ? "border-accent-rule bg-accent-soft text-accent"
          : "border-transparent text-muted hover:border-rule-strong hover:text-ink"
      }`}
    >
      <Icon size={16} strokeWidth={1.75} />
      {badge && badge > 0 ? (
        <span
          aria-hidden
          className="border-caution-rule bg-caution text-paper numeric absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full border px-1 text-[10px] leading-4"
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function PanelFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-rule px-3">
        <span className="label-micro">{title}</span>
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
          className="relative inline-flex size-7 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] hover:text-ink"
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function OverlayDialog({
  open,
  label,
  onClose,
  children,
  side = "left",
  restoreFocusTo,
}: {
  open: boolean;
  label: string;
  onClose(): void;
  children: ReactNode;
  side?: "left" | "right";
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => (!next ? onClose() : undefined)}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onCloseAutoFocus={(event) => {
            if (!restoreFocusTo) return;
            event.preventDefault();
            restoreFocusTo.current?.focus();
          }}
          className={`fixed top-0 z-50 h-dvh border-rule bg-paper outline-none data-[state=open]:animate-in ${
            side === "left"
              ? "left-0 w-80 max-w-[85vw] border-r"
              : "right-0 w-96 max-w-[100vw] border-l"
          }`}
        >
          <DialogPrimitive.Title className="sr-only">
            {label}
          </DialogPrimitive.Title>
          <div className="h-full min-h-0">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The left/right columns become overlays below this width, so one column is usable. */
const WIDE_QUERY = "(min-width: 1024px)";

export function Shell({ left }: { left?: ReactNode }) {
  const runtime = useChatRuntime();
  const session = useSession();
  const lock = useVaultStore((s) => s.lock);
  // Re-render the rail when a delegated run queues an approval.
  useRegistryVersion(agentRunStore);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const agentPending = agentRunStore.pendingApprovalCount(activeThreadId ?? undefined);
  const wide = useMediaQuery(WIDE_QUERY);
  const bootstrapped = useRef(false);

  // One-time bootstrap so the center column is usable on first load, on any
  // viewport: select the most recent conversation when none is active.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    let cancelled = false;
    void (async () => {
      if (useChatStore.getState().activeThreadId !== null) return;
      const result = await listThreadSummaries();
      if (cancelled || result.summaries.length === 0) return;
      const id = result.summaries[0].id;
      const loaded = await session.threadStore.loadThread(id);
      if (cancelled || !loaded) return;
      useChatStore.getState().setThread(rehydrateThread(loaded));
      useChatStore.getState().setActiveThread(id);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const [rail, setRail] = useState<RailPanelState>(readRailState);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(readSidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [configTab, setConfigTab] = useState<ConfigTab>("thread");
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const railTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(RAIL_STATE_KEY, JSON.stringify(rail));
    } catch {
      // Storage disabled: panel state simply does not survive this session.
    }
  }, [rail]);

  // Track the viewport so the stored width is re-clamped when the window shrinks.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(
        SIDEBAR_STATE_KEY,
        sidebarCollapsed ? "collapsed" : "expanded",
      );
    } catch {
      // Storage disabled: the collapse preference simply does not survive.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const panelMax = panelWidthMax(viewportWidth);
  const panelWidth = clampPanelWidth(rail.width, viewportWidth);

  const openWorkspaceFile = useFileViewStore((s) => s.openWorkspace);

  // Every entry point that sets a target — the Workspace tree, the File panel's
  // URL bar, or a chat link — reveals the File panel. Subscribing keeps the
  // setState in a store callback rather than in the effect body.
  useEffect(
    () =>
      useFileViewStore.subscribe((state) => {
        if (!state.target) return;
        setRail((prev) =>
          prev.open && prev.activePanel === "files"
            ? prev
            : { ...prev, open: true, activePanel: "files" },
        );
      }),
    [],
  );

  const openWorkspacePanel = () =>
    setRail((prev) => ({ ...prev, open: true, activePanel: "workspace" }));

  const panels: RailPanelDef[] = [
    {
      id: "config",
      label: "Config",
      icon: Settings2,
      render: () => <ChatConfig tab={configTab} onTabChange={setConfigTab} />,
    },
    {
      id: "workspace",
      label: "Workspace",
      icon: FolderTree,
      render: () => <WorkspacePanel onOpenFile={openWorkspaceFile} />,
    },
    {
      id: "files",
      label: "File",
      icon: FileText,
      render: () => <FilePanel onBrowseWorkspace={openWorkspacePanel} />,
    },
    {
      id: "documents",
      label: "Documents",
      icon: BookOpen,
      render: () => <LibraryPanel />,
    },
    {
      id: "skills",
      label: "Skills",
      icon: Sparkles,
      render: () => <SkillsPanel />,
    },
    { id: "tools", label: "Tools", icon: Wrench, render: () => <ToolsPanel /> },
    {
      id: "sandbox",
      label: "Sandbox",
      icon: Boxes,
      render: () => <SandboxPanel />,
    },
    {
      id: "agents",
      label: "Agents",
      icon: Bot,
      render: () => <AgentsPanel />,
    },
    {
      id: "approvals",
      label: "Approvals",
      icon: ShieldCheck,
      render: () => <ApprovalsPanel />,
    },
  ];
  const active =
    panels.find((panel) => panel.id === rail.activePanel) ?? panels[0];

  const togglePanel = (id: RailPanelId) => {
    setRail((prev) =>
      prev.open && prev.activePanel === id
        ? { ...prev, open: false }
        : { ...prev, open: true, activePanel: id },
    );
  };

  const closeRail = () => setRail((prev) => ({ ...prev, open: false }));
  const openProviders = () => {
    setConfigTab("providers");
    setDrawerOpen(false);
    setRail((prev) => ({ ...prev, open: true, activePanel: "config" }));
  };
  const closeDrawer = () => setDrawerOpen(false);

  const panelBody = (
    <PanelFrame title={active.label} onClose={closeRail}>
      {active.render()}
    </PanelFrame>
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-paper text-ink">
      {wide ? (
        sidebarCollapsed ? null : (
          <aside className="flex w-72 shrink-0 flex-col border-r border-rule">
            {left ?? (
              <Conversations
                onOpenProviders={openProviders}
                onCollapse={() => setSidebarCollapsed(true)}
              />
            )}
          </aside>
        )
      ) : (
        <OverlayDialog
          open={drawerOpen}
          label="Conversations"
          onClose={closeDrawer}
          restoreFocusTo={menuTriggerRef}
        >
          {left ?? (
            <Conversations
              onOpenProviders={openProviders}
              onClose={closeDrawer}
            />
          )}
        </OverlayDialog>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-rule px-3 sm:px-4">
          <div className="flex items-center gap-2">
            {!wide ? (
              <button
                type="button"
                aria-label="Open conversations"
                onClick={(event) => {
                  menuTriggerRef.current = event.currentTarget;
                  setDrawerOpen(true);
                }}
                className="inline-flex size-9 items-center justify-center rounded-sm text-muted transition-colors hover:text-ink"
              >
                <Menu size={17} strokeWidth={1.75} />
              </button>
            ) : (
              <button
                type="button"
                aria-label={
                  sidebarCollapsed ? "Show conversations" : "Hide conversations"
                }
                aria-pressed={sidebarCollapsed}
                title={
                  sidebarCollapsed ? "Show conversations" : "Hide conversations"
                }
                onClick={() => setSidebarCollapsed((prev) => !prev)}
                className="relative inline-flex size-9 items-center justify-center rounded-sm border border-transparent text-muted transition-colors duration-150 ease-out-quart after:absolute after:-inset-0.5 after:content-[''] hover:border-rule-strong hover:text-ink"
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen size={17} strokeWidth={1.75} />
                ) : (
                  <PanelLeftClose size={17} strokeWidth={1.75} />
                )}
              </button>
            )}
            <span className="text-sm font-medium tracking-tight text-ink">
              Sagent Studio
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void lock()}
              icon={<LockIcon size={14} strokeWidth={1.75} />}
            >
              Lock
            </Button>
          </div>
        </header>

        <PlanPanel />

        <div className="min-h-0 flex-1">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread />
          </AssistantRuntimeProvider>
        </div>
      </main>

      <div className="flex h-full w-12 shrink-0 flex-col items-center gap-0.5 border-l border-rule bg-paper-sunk/60 py-2">
        {panels.map((panel) => (
          <RailButton
            key={panel.id}
            id={panel.id}
            label={panel.label}
            icon={panel.icon}
            active={rail.open && rail.activePanel === panel.id}
            {...(panel.id === "agents" ? { badge: agentPending } : {})}
            onClick={(event) => {
              railTriggerRef.current = event.currentTarget;
              togglePanel(panel.id);
            }}
          />
        ))}
      </div>

      {wide && rail.open ? (
        <>
          <ResizeHandle
            label={`Resize ${active.label} panel`}
            width={panelWidth}
            max={panelMax}
            onChange={(next) => setRail((prev) => ({ ...prev, width: next }))}
          />
          <section
            style={{ width: panelWidth }}
            className="flex shrink-0 flex-col bg-paper-sunk/50 motion-safe:animate-[panel-in_180ms_var(--ease-out-quint)]"
          >
            {panelBody}
          </section>
        </>
      ) : null}

      {!wide && rail.open ? (
        <OverlayDialog
          open
          label={active.label}
          onClose={closeRail}
          side="right"
          restoreFocusTo={railTriggerRef}
        >
          {panelBody}
        </OverlayDialog>
      ) : null}
    </div>
  );
}

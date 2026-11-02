import { useMemo } from "react";
import { MessageSquareIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useAcpAgentCapabilities, useAcpSessionId } from "@assistant-ui/acp";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The session list, in the page.
 *
 * The extension cannot draw one — a webview sidebar has no room and VS Code puts
 * a QuickPick on the view title instead — so `vscode.tsx` publishes this same
 * list over postMessage and the native half mirrors it (`VscodeBridge`,
 * `pickSession`). Here the runtime's own thread list is the whole
 * implementation: `useAuiState(s => s.threads.threadItems)` for the rows and
 * `useAui().threads.*` for the four actions, which is the identical API the
 * bridge drives, so a session created in the page and one created from the
 * editor's dropdown are the same object.
 */

function relativeTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ThreadSidebar({ className }: { className?: string }) {
  const aui = useAui();
  const items = useAuiState((s) => s.threads.threadItems);
  const ids = useAuiState((s) => s.threads.threadIds);
  const activeId = useAcpSessionId();
  // `threadItems` is the runtime's lookup record flattened to an array, and the
  // external store seeds that record with a placeholder main-thread entry which
  // `Object.assign` then carries through every rebuild — so it can hold a row
  // that is not one of the agent's sessions (and clicking it would ask the agent
  // to resume an id it never minted). `threadIds` is the agent's own list, in
  // the agent's order; the rows follow it.
  const threads = useMemo(() => items.filter((item) => ids.includes(item.id)), [items, ids]);
  // An agent that cannot delete a session gets no delete button, rather than a
  // button that fails: the capability is advertised in the handshake.
  const canDelete = useAcpAgentCapabilities()?.sessionCapabilities?.delete != null;

  return (
    <nav
      data-testid="thread-sidebar"
      aria-label="Sessions"
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border flex w-60 shrink-0 flex-col border-r",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-1 border-b px-2 py-1.5">
        <span className="text-muted-foreground px-1 text-xs font-medium">Sessions</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            data-testid="new-thread"
            aria-label="New session"
            title="New session"
            className="size-7 p-0"
            onClick={() => aui.threads.switchToNewThread()}
          >
            <PlusIcon aria-hidden className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="refresh-threads"
            aria-label="Refresh sessions"
            title="Refresh sessions"
            className="size-7 p-0"
            onClick={() => void aui.threads.reload()}
          >
            <RefreshCwIcon aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        {threads.length === 0 && (
          <li className="text-muted-foreground px-2 py-3 text-xs" data-testid="no-threads">
            No sessions yet — start one.
          </li>
        )}
        {threads.map((thread) => {
          const active = thread.id === activeId;
          const updatedAt = typeof thread.custom?.updatedAt === "string" ? thread.custom.updatedAt : undefined;
          const when = relativeTime(updatedAt);
          return (
            <li key={thread.id} className="group relative">
              <button
                type="button"
                data-testid="thread-row"
                data-id={thread.id}
                data-active={active ? "true" : undefined}
                data-running={thread.isRunning ? "true" : undefined}
                aria-current={active ? "true" : undefined}
                onClick={() => aui.threads.switchToThread(thread.id)}
                className={cn(
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
                  canDelete && "pr-8",
                )}
              >
                <MessageSquareIcon
                  aria-hidden
                  className={cn("mt-0.5 size-3.5 shrink-0", thread.isRunning && "text-success animate-pulse")}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{thread.title || thread.id}</span>
                  {when && <span className="text-muted-foreground block text-[11px]">{when}</span>}
                </span>
              </button>
              {canDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="delete-thread"
                  data-id={thread.id}
                  aria-label={`Delete session ${thread.title || thread.id}`}
                  title="Delete session"
                  className="absolute top-1 right-1 size-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => aui.threads.item({ id: thread.id }).delete()}
                >
                  <Trash2Icon aria-hidden className="size-3.5" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

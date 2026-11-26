import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useAcpRuntime, useAcpSessionId, type AcpMcpServer, type UseAcpRuntimeOptions } from "@assistant-ui/acp";
import { AssistantRuntimeProvider, useAssistantDataUI, useAui } from "@assistant-ui/react";
import { retainComposerFocus } from "@/lib/composer-focus";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/elements/thread.aui";
import { CollapseAwareReasoningGroup } from "@/components/collapse-aware-reasoning";
import { COMPACTION_DATA_UI } from "@/components/compaction-card";
import { AcpToolCard } from "@/components/tools/acp-tool-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCollapseAllKey } from "@/lib/collapse-all";
import { chatAttachments } from "@/lib/chat-attachments";

const THREAD_COMPONENTS = {
  ToolFallback: AcpToolCard,
  ReasoningGroup: CollapseAwareReasoningGroup,
} satisfies ThreadComponents;

export function ChatThread({ composerStatus }: { composerStatus?: ComponentType | undefined }) {
  const sessionId = useAcpSessionId();
  // Compaction rides the thread as a named `data` part, which assistant-ui only
  // draws once a renderer is registered for that name.
  useAssistantDataUI(COMPACTION_DATA_UI);
  const aui = useAui();
  // Long runs can blur the webview to <body>; keep the empty composer usable.
  useEffect(() => retainComposerFocus({
    doc: document,
    win: window,
    isRunning: () => aui.thread.getState().isRunning,
    composer: () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]'),
  }), [aui]);
  const components = useMemo<ThreadComponents>(
    () => (composerStatus ? { ...THREAD_COMPONENTS, ComposerStatus: composerStatus } : THREAD_COMPONENTS),
    [composerStatus],
  );
  if (!sessionId) return <p role="status" className="text-muted-foreground p-4 text-sm">Opening chat session…</p>;
  return <Thread components={components} />;
}

export function ChatSession({
  url, cwd, mcpServers, protocol, children,
}: {
  url: string;
  cwd: string;
  mcpServers: readonly AcpMcpServer[];
  protocol?: UseAcpRuntimeOptions["protocol"];
  children: (error: string | null) => ReactNode;
}) {
  useCollapseAllKey();
  const [error, setError] = useState<string | null>(null);
  const runtime = useAcpRuntime({
    url, cwd, mcpServers, protocol,
    clientInfo: { name: "crow-chat", version: "0.1.0" },
    restoreOnConnect: true,
    adapters: { attachments: chatAttachments },
    unstable_enableMessageQueue: true,
    onError: (error) => {
      console.error("[acp]", error.message);
      setError(error.message);
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>{children(error)}</TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

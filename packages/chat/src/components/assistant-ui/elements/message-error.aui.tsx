"use client";

import type { FC } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { ErrorPrimitive, MessagePrimitive } from "@assistant-ui/react";
import { useMessageError } from "@assistant-ui/core/react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * The red error bubble: a turn that ended in error (v2 idle stopReason
 * "error" with the crash text lifted into the status, or a JSON-RPC prompt
 * rejection) renders its message here instead of as reply text. The copy
 * button sits top right and copies the full error text.
 */
export const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 relative mt-2 rounded-md border p-3 pr-10 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message whitespace-pre-wrap break-words" />
        <MessageErrorCopy />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const MessageErrorCopy: FC = () => {
  const error = useMessageError();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const text = typeof error === "string" ? error : String(error ?? "");
  return (
    <TooltipIconButton
      tooltip="Copy error"
      className="absolute top-1.5 right-1.5 size-6"
      onClick={() => copyToClipboard(text)}
    >
      {!isCopied && (
        <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
      )}
      {isCopied && (
        <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
      )}
    </TooltipIconButton>
  );
};

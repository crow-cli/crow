/// <reference types="bun-types" />
/**
 * HUNT: a crashed turn must surface as an error, not a normal completion.
 *
 * agent2's driver reports a turn that raised as a trailing whole-message
 * upsert `agent error: {exc}` followed by `state_update: idle` with
 * stopReason "error" (the open-string StopReason of schema alpha.7+). The
 * client must map that to assistant-ui's incomplete/error status and lift
 * the error text out of the reply into `status.error`, which is what
 * MessagePrimitive.Error / ErrorPrimitive render as the red bubble.
 */
import { describe, expect, it } from "bun:test";
import {
  EMPTY_ACP_THREAD_STATE,
  isAcpStateRunning,
  reduceAcpThreadState,
  type AcpAssistantMessage,
  type AcpThreadEvent,
  type AcpThreadState,
} from "../../../aui/acp/src/acpThreadState";
import { stopReasonToMessageStatus } from "../../../aui/acp/src/conversions";
import type { AcpSessionUpdate, AcpStopReason } from "../../../aui/acp/src/types";

const reduce = (state: AcpThreadState, event: AcpThreadEvent) =>
  reduceAcpThreadState(state, event);

const send = (state: AcpThreadState, update: AcpSessionUpdate) =>
  reduce(state, { type: "session-update", update });

const running = (): AcpSessionUpdate => ({
  sessionUpdate: "state_update",
  state: "running",
});

const idle = (stopReason: AcpStopReason = "end_turn"): AcpSessionUpdate => ({
  sessionUpdate: "state_update",
  state: "idle",
  stopReason,
});

const chunk = (text: string, messageId = "m1"): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
});

/** The driver's crash report: a whole-message upsert, then idle("error"). */
const crashReport = (text: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_message",
  messageId: "err-1",
  content: [{ type: "text", text }],
});

const assistantMessages = (state: AcpThreadState): AcpAssistantMessage[] =>
  state.messageOrder
    .map((id) => state.messagesById[id])
    .filter((m): m is AcpAssistantMessage => m?.role === "assistant");

const textOf = (state: AcpThreadState, id: string): string => {
  const message = state.messagesById[id];
  if (!message) throw new Error(`no message ${id}`);
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
};

const clientRunState = (text: string): AcpThreadState => {
  const message: AcpAssistantMessage = {
    role: "assistant",
    id: "a1",
    parentId: null,
    createdAt: Date.now(),
    status: { type: "running" },
    content: [{ type: "text", text }],
  };
  return reduce(EMPTY_ACP_THREAD_STATE, { type: "run-start", message });
};

describe("stopReasonToMessageStatus", () => {
  it("maps the error stop reason to incomplete/error", () => {
    expect(stopReasonToMessageStatus("error")).toEqual({
      type: "incomplete",
      reason: "error",
    });
  });
});

describe("crashed autonomous turn (agent-origin run)", () => {
  it("lifts the crash text into the error status, keeping the partial reply", () => {
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    state = send(state, chunk("Working on it. "));
    state = send(state, crashReport("agent error: boom"));
    state = send(state, idle("error"));

    const assistants = assistantMessages(state);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "boom",
    });
    expect(textOf(state, assistants[0]!.id)).toBe("Working on it. ");
    expect(isAcpStateRunning(state)).toBe(false);
  });

  it("reports a crash with no prior content as a bare error bubble", () => {
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    state = send(state, crashReport("agent error: boom"));
    state = send(state, idle("error"));

    const assistants = assistantMessages(state);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "boom",
    });
    expect(textOf(state, assistants[0]!.id)).toBe("");
  });

  it("splits the marker out of a merged text part", () => {
    // Consecutive text blocks merge into one part; the marker can land
    // mid-part rather than at a part boundary.
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    state = send(state, chunk("half a thought"));
    state = send(state, chunk("agent error: boom"));
    state = send(state, idle("error"));

    const assistants = assistantMessages(state);
    expect(assistants[0]!.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "boom",
    });
    expect(textOf(state, assistants[0]!.id)).toBe("half a thought");
  });

  it("leaves a normal end_turn untouched", () => {
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    state = send(state, chunk("all done"));
    state = send(state, idle("end_turn"));
    const assistants = assistantMessages(state);
    expect(assistants[0]!.status).toEqual({ type: "complete", reason: "stop" });
    expect(textOf(state, assistants[0]!.id)).toBe("all done");
  });
});

describe("crashed client turn (run-end)", () => {
  it("lifts the crash text when the prompt resolves with error", () => {
    const state = reduce(
      clientRunState("partial replyagent error: boom"),
      { type: "run-end", status: stopReasonToMessageStatus("error") },
    );
    const assistants = assistantMessages(state);
    expect(assistants[0]!.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "boom",
    });
    expect(textOf(state, assistants[0]!.id)).toBe("partial reply");
  });

  it("keeps a JSON-RPC rejection's own error and the reply text", () => {
    const state = reduce(clientRunState("some reply"), {
      type: "run-end",
      status: { type: "incomplete", reason: "error", error: "rpc died" },
    });
    const assistants = assistantMessages(state);
    expect(assistants[0]!.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "rpc died",
    });
    expect(textOf(state, assistants[0]!.id)).toBe("some reply");
  });

  it("falls back to the generic bubble when no crash text is present", () => {
    const state = reduce(clientRunState("some reply"), {
      type: "run-end",
      status: stopReasonToMessageStatus("error"),
    });
    const assistants = assistantMessages(state);
    expect(assistants[0]!.status).toEqual({
      type: "incomplete",
      reason: "error",
    });
    expect(textOf(state, assistants[0]!.id)).toBe("some reply");
  });
});

/// <reference types="bun-types" />
/**
 * HUNT: an agent turn that starts WITHOUT a client `session/prompt`.
 *
 * agent2's driver wakes on a mailbox delivery (an async task/subagent
 * finished), a goal continuation, or a timer, and runs an ordinary turn:
 * `state_update: running`, the injected delivery as `user_message_chunk`,
 * streamed content, then `state_update: idle(stopReason)`. No prompt
 * request/response is involved — the state updates ARE the turn boundary.
 *
 * These tests feed that exact wire sequence to the client and demand the
 * turn be visible. Before the fix the reducer ignored `state_update`, so
 * every frame of an autonomous turn was dropped on the floor.
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
import { AcpThreadController } from "../../../aui/acp/src/AcpThreadController";
import type {
  AcpClientLike,
  AcpSessionUpdateListener,
} from "../../../aui/acp/src/AcpClient";
import type {
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpSessionUpdate,
  AcpStopReason,
} from "../../../aui/acp/src/types";

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

const delivery = (text: string): AcpSessionUpdate => ({
  sessionUpdate: "user_message_chunk",
  messageId: `delivery-${text.length}`,
  content: { type: "text", text },
});

const chunk = (text: string, messageId = "m1"): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
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

/** The wire sequence of one autonomous wake, as agent2's driver emits it. */
const autonomousTurn = (state: AcpThreadState): AcpThreadState => {
  let next = send(state, running());
  next = send(next, delivery("[task result] training finished: success=0.81"));
  next = send(next, chunk("The task finished. ", "m1"));
  next = send(next, chunk("Success rate 0.81.", "m1"));
  next = send(next, idle("end_turn"));
  return next;
};

describe("autonomous turn (no session/prompt)", () => {
  it("renders the delivery and the reply, and settles on idle", () => {
    const state = autonomousTurn(EMPTY_ACP_THREAD_STATE);

    // The delivery is a user-role message on screen.
    const users = state.messageOrder
      .map((id) => state.messagesById[id])
      .filter((m) => m?.role === "user");
    expect(users).toHaveLength(1);
    expect(textOf(state, users[0]!.id)).toContain("training finished");

    // The reply is one assistant message with the streamed text.
    const assistants = assistantMessages(state);
    expect(assistants).toHaveLength(1);
    expect(textOf(state, assistants[0]!.id)).toBe(
      "The task finished. Success rate 0.81.",
    );
    expect(assistants[0]!.status).toEqual({ type: "complete", reason: "stop" });

    // Delivery precedes the reply; the turn is over.
    expect(state.messageOrder.indexOf(users[0]!.id)).toBeLessThan(
      state.messageOrder.indexOf(assistants[0]!.id),
    );
    expect(isAcpStateRunning(state)).toBe(false);
  });

  it("shows running between the boundary updates", () => {
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    expect(isAcpStateRunning(state)).toBe(true);
    state = send(state, chunk("working"));
    expect(isAcpStateRunning(state)).toBe(true);
    state = send(state, idle());
    expect(isAcpStateRunning(state)).toBe(false);
  });

  it("renders a wake with no delivery text (goal continuation)", () => {
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    state = send(state, chunk("Continuing the goal."));
    state = send(state, idle());
    const assistants = assistantMessages(state);
    expect(assistants).toHaveLength(1);
    expect(textOf(state, assistants[0]!.id)).toBe("Continuing the goal.");
    expect(assistants[0]!.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("settles a cancelled autonomous turn as cancelled", () => {
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    state = send(state, chunk("half a thought"));
    state = send(state, idle("cancelled"));
    const assistants = assistantMessages(state);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.status).toEqual({
      type: "incomplete",
      reason: "cancelled",
    });
    expect(isAcpStateRunning(state)).toBe(false);
  });

  it("renders tool calls made during an autonomous turn", () => {
    let state = send(EMPTY_ACP_THREAD_STATE, running());
    state = send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "execute",
      kind: "execute",
      status: "in_progress",
      rawInput: { code: "print(1)" },
    });
    state = send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    state = send(state, idle());
    const assistants = assistantMessages(state);
    expect(assistants).toHaveLength(1);
    const toolParts = assistants[0]!.content.filter(
      (p) => p.type === "tool-call",
    );
    expect(toolParts).toHaveLength(1);
  });

  it("a park idle with no turn in flight changes nothing", () => {
    const state = send(EMPTY_ACP_THREAD_STATE, idle());
    expect(state).toBe(EMPTY_ACP_THREAD_STATE);
  });

  it("a state_update during replay does not open a live run", () => {
    let state = reduce(EMPTY_ACP_THREAD_STATE, { type: "replay-start" });
    state = send(state, running());
    expect(isAcpStateRunning(state)).toBe(false);
    expect(state.replay.type).toBe("active");
  });
});

describe("client-prompted turns keep their semantics", () => {
  const clientRun = (state: AcpThreadState): AcpThreadState =>
    reduce(state, {
      type: "run-start",
      message: {
        role: "assistant",
        id: "a1",
        parentId: null,
        createdAt: 0,
        status: { type: "running" },
        content: [],
      },
    });

  it("running state_update does not mint a second assistant", () => {
    let state = clientRun(EMPTY_ACP_THREAD_STATE);
    state = send(state, running());
    state = send(state, chunk("hello"));
    expect(assistantMessages(state)).toHaveLength(1);
    expect(textOf(state, "a1")).toBe("hello");
  });

  it("idle does not settle a client run — the controller owns that edge", () => {
    let state = clientRun(EMPTY_ACP_THREAD_STATE);
    state = send(state, chunk("hello"));
    state = send(state, idle());
    // Still running: run-end (dispatched when the prompt promise resolves)
    // settles it, and a steered handoff must not see a gap here.
    expect(isAcpStateRunning(state)).toBe(true);
    state = reduce(state, {
      type: "run-end",
      status: { type: "complete", reason: "stop" },
    });
    expect(isAcpStateRunning(state)).toBe(false);
    const a1 = state.messagesById["a1"];
    if (a1?.role !== "assistant") throw new Error("a1 is not an assistant");
    expect(a1.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("a user chunk inside a client run stays dropped — it is the prompt echo", () => {
    // Agents echo the accepted prompt as user chunks (the stub) or as a whole
    // user_message (agent2); either way the controller already showed it.
    // Only an agent-origin run's user chunks are new history.
    let state = clientRun(EMPTY_ACP_THREAD_STATE);
    state = send(state, delivery("echo of the prompt"));
    state = send(state, chunk("Noted."));
    const users = state.messageOrder.filter(
      (id) => state.messagesById[id]?.role === "user",
    );
    expect(users).toHaveLength(0);
    expect(textOf(state, "a1")).toBe("Noted.");
  });
});

// -- controller level: a stub client that speaks the v2 turn boundary ------

type StubClient = AcpClientLike & {
  emit(update: AcpSessionUpdate): void;
  cancelCalls: number;
  prompts: number;
  askPermission(request: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
};

const makeStubClient = (): StubClient => {
  const listeners = new Set<AcpSessionUpdateListener>();
  const promptWaiters: ((reason: AcpStopReason) => void)[] = [];
  const stub: StubClient = {
    cancelCalls: 0,
    prompts: 0,
    hasConfiguredPermissionHandler: false,
    connectionState: "connected",
    sessionId: "s1",
    agentInfo: undefined,
    agentCapabilities: undefined,
    modes: undefined,
    configOptions: undefined,
    permissionHandler: () => ({ outcome: "cancelled" }),
    subscribeSessionUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeConnectionChange() {
      return () => {};
    },
    async connect() {
      return { protocolVersion: 2 };
    },
    async ensureSession() {
      return "s1";
    },
    async listSessions() {
      return { sessions: [] };
    },
    async loadSession(sessionId: string) {
      return sessionId;
    },
    async deleteSession() {},
    async setConfigOption() {
      return [];
    },
    releaseSession() {},
    prompt() {
      stub.prompts += 1;
      // v2: the prompt acks now; the turn's verdict arrives on an idle edge.
      return new Promise<AcpStopReason>((resolve) => {
        promptWaiters.push(resolve);
      });
    },
    async cancel() {
      stub.cancelCalls += 1;
    },
    dispose() {},
    emit(update) {
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        promptWaiters.shift()?.(update.stopReason ?? "end_turn");
      }
      for (const listener of [...listeners]) listener("s1", update);
    },
    askPermission(request) {
      return Promise.resolve(stub.permissionHandler(request));
    },
  };
  return stub;
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const permissionRequest: AcpPermissionRequest = {
  sessionId: "s1",
  toolCall: {
    toolCallId: "t-perm",
    title: "execute",
    kind: "execute",
    status: "pending",
    rawInput: { code: "rm -rf /tmp/x" },
  },
  options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
};

describe("controller: autonomous turn", () => {
  it("shows the turn, surfaces its permission ask, and settles on idle", async () => {
    const stub = makeStubClient();
    const controller = new AcpThreadController({
      client: stub,
      autoConnect: false,
    });
    await controller.attach();

    stub.emit(running());
    stub.emit(chunk("checking the task"));
    expect(isAcpStateRunning(controller.getState())).toBe(true);

    // A permission ask mid autonomous turn must reach the user, not be
    // auto-cancelled because no client prompt is in flight.
    let settled: AcpPermissionOutcome | undefined;
    void stub.askPermission(permissionRequest).then((o) => {
      settled = o;
    });
    await tick();
    expect(settled).toBeUndefined();
    expect(Object.keys(controller.getState().permissions)).toHaveLength(1);

    stub.emit(idle("end_turn"));
    await tick();
    const state = controller.getState();
    expect(isAcpStateRunning(state)).toBe(false);
    const assistants = assistantMessages(state);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.status).toEqual({ type: "complete", reason: "stop" });
    // The turn ended without an answer: the ask is cancelled, not left open.
    expect(settled).toEqual({ outcome: "cancelled" });
    expect(Object.keys(state.permissions)).toHaveLength(0);

    await controller.dispose();
  });

  it("a user prompt during an autonomous turn cancels it and takes over", async () => {
    const stub = makeStubClient();
    const controller = new AcpThreadController({
      client: stub,
      autoConnect: false,
    });
    await controller.attach();

    stub.emit(running());
    stub.emit(chunk("autonomous work"));
    expect(isAcpStateRunning(controller.getState())).toBe(true);

    const appending = controller.append({
      role: "user",
      content: [{ type: "text", text: "stop that, do this instead" }],
      attachments: [],
      createdAt: new Date(),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    });
    await tick();
    await tick();

    // The autonomous turn was cancelled on the wire...
    expect(stub.cancelCalls).toBe(1);
    // ...and the user's prompt went out.
    expect(stub.prompts).toBe(1);

    // The driver answers the cancel, then runs the user's turn.
    stub.emit(idle("cancelled"));
    await tick();
    stub.emit(running());
    stub.emit(chunk("doing this instead", "m2"));
    stub.emit(idle("end_turn"));
    await appending;

    const state = controller.getState();
    expect(isAcpStateRunning(state)).toBe(false);
    const last = assistantMessages(state).at(-1)!;
    expect(textOf(state, last.id)).toBe("doing this instead");
    expect(last.status).toEqual({ type: "complete", reason: "stop" });

    await controller.dispose();
  });
});

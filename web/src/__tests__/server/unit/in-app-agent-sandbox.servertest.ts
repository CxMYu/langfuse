import { EventType } from "@ag-ui/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LambdaMicrovmsModule from "@aws-sdk/client-lambda-microvms";
import type * as SharedServerModule from "@langfuse/shared/src/server";

import { getSandboxToolCallFiles } from "@/src/ee/features/in-app-agent/server/persistence";
import {
  createInAppAgentSandbox,
  createLambdaMicrovmSandboxProvider,
  type SandboxProvider,
} from "@/src/ee/features/in-app-agent/server/sandbox";

const lambdaMicrovmsSendMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@aws-sdk/client-lambda-microvms", async () => {
  const actual = (await vi.importActual(
    "@aws-sdk/client-lambda-microvms",
  )) as typeof LambdaMicrovmsModule;

  class MockLambdaMicrovmsClient {
    send = lambdaMicrovmsSendMock;
  }

  return {
    ...actual,
    LambdaMicrovmsClient: MockLambdaMicrovmsClient,
  };
});

vi.mock("@langfuse/shared/src/server", async () => {
  const actual = (await vi.importActual(
    "@langfuse/shared/src/server",
  )) as typeof SharedServerModule;

  return {
    ...actual,
    getInAppAgentSandboxSnapshotKey: (
      projectId: string,
      conversationId: string,
    ) => `in-app-agent-sandboxes/${projectId}/${conversationId}.snapshot`,
  };
});

describe("in-app agent sandbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    lambdaMicrovmsSendMock.mockReset();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reuses an active sandbox and restores it after suspension", async () => {
    const files = new Map<string, string>();
    let snapshot = new Map<string, string>();
    let activeSessionId: string | null = null;
    let sessionCounter = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const provider: SandboxProvider = {
      name: "test-fake",
      async ensureSession({ sessionId }) {
        if (sessionId && activeSessionId === sessionId) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          return { sessionId };
        }

        activeSessionId = `session-${sessionCounter++}`;
        files.clear();
        for (const [path, content] of snapshot.entries()) {
          files.set(path, content);
        }
        return { sessionId: activeSessionId };
      },
      async syncReadonlyFiles({ files: readonlyFiles }) {
        for (const key of Array.from(files.keys())) {
          if (key.startsWith("tool_calls/")) files.delete(key);
        }
        for (const file of readonlyFiles) {
          files.set(file.path, file.content);
        }
      },
      async read({ path }) {
        return { path, content: files.get(path) ?? null };
      },
      async write({ path, content }) {
        files.set(path, content);
        return { path, bytesWritten: content.length };
      },
      async edit({ path, oldText, newText }) {
        const current = files.get(path) ?? "";
        const replaced = current.includes(oldText);
        if (replaced) files.set(path, current.replace(oldText, newText));
        return { path, replaced };
      },
      async bash() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      scheduleSuspension({ expiresAt }) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          () => {
            snapshot = new Map(files.entries());
            activeSessionId = null;
          },
          Math.max(0, expiresAt.getTime() - Date.now()),
        );
      },
    };
    let sandboxState: {
      providerSessionId: string | null;
      sandboxExpiresAt: Date | null;
      sandboxProvider: string | null;
      sandboxSnapshotKey: string | null;
    } = {
      providerSessionId: null,
      sandboxExpiresAt: null,
      sandboxProvider: null,
      sandboxSnapshotKey: null,
    };

    const createSandbox = () =>
      createInAppAgentSandbox({
        conversationId: "conversation-1",
        projectId: "project-1",
        providerSessionId: sandboxState.providerSessionId,
        sandboxExpiresAt: sandboxState.sandboxExpiresAt,
        sandboxProvider: sandboxState.sandboxProvider,
        sandboxSnapshotKey: sandboxState.sandboxSnapshotKey,
        ttlMs: 1_000,
        provider,
        getToolCallFiles: async () => [],
        saveState: async (nextState) => {
          sandboxState = {
            ...sandboxState,
            ...nextState,
            providerSessionId:
              nextState.providerSessionId ?? sandboxState.providerSessionId,
            sandboxExpiresAt:
              nextState.sandboxExpiresAt ?? sandboxState.sandboxExpiresAt,
            sandboxProvider:
              nextState.sandboxProvider ?? sandboxState.sandboxProvider,
            sandboxSnapshotKey:
              nextState.sandboxSnapshotKey ?? sandboxState.sandboxSnapshotKey,
          };
        },
      });

    const firstSandbox = await createSandbox();
    await firstSandbox.write({ path: "notes.txt", content: "hello" });
    const firstSessionId = sandboxState.providerSessionId;

    const secondSandbox = await createSandbox();
    await expect(secondSandbox.read({ path: "notes.txt" })).resolves.toEqual({
      path: "notes.txt",
      content: "hello",
    });
    expect(sandboxState.providerSessionId).toBe(firstSessionId);

    await firstSandbox.onTurnEnded();
    await vi.advanceTimersByTimeAsync(1_001);

    const restoredSandbox = await createSandbox();
    await expect(restoredSandbox.read({ path: "notes.txt" })).resolves.toEqual({
      path: "notes.txt",
      content: "hello",
    });
    expect(sandboxState.providerSessionId).not.toBe(firstSessionId);
    expect(sandboxState.sandboxProvider).toBe("test-fake");
    expect(sandboxState.sandboxSnapshotKey).toBe(
      "in-app-agent-sandboxes/project-1/conversation-1.snapshot",
    );
  });

  it("persists sandbox ttl metadata when a turn ends", async () => {
    const provider: SandboxProvider = {
      name: "test-fake",
      async ensureSession() {
        return { sessionId: "session-1" };
      },
      async syncReadonlyFiles() {},
      async read() {
        return { path: "notes.txt", content: null };
      },
      async write() {
        return { path: "notes.txt", bytesWritten: 0 };
      },
      async edit() {
        return { path: "notes.txt", replaced: false };
      },
      async bash() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async scheduleSuspension() {
        return;
      },
    };
    const savedStates: Array<Record<string, unknown>> = [];
    const sandbox = await createInAppAgentSandbox({
      conversationId: "conversation-1",
      projectId: "project-1",
      ttlMs: 1_000,
      provider,
      getToolCallFiles: async () => [],
      saveState: async (state) => {
        savedStates.push(state);
      },
      now: () => new Date("2026-07-02T12:00:00.000Z"),
    });

    await sandbox.write({ path: "notes.txt", content: "hello" });
    await sandbox.onTurnEnded();

    expect(savedStates[0]).toMatchObject({
      providerSessionId: "session-1",
      sandboxProvider: "test-fake",
      sandboxSnapshotKey:
        "in-app-agent-sandboxes/project-1/conversation-1.snapshot",
      sandboxExpiresAt: null,
    });
    expect(savedStates[1]).toMatchObject({
      providerSessionId: "session-1",
      sandboxProvider: "test-fake",
      sandboxSnapshotKey:
        "in-app-agent-sandboxes/project-1/conversation-1.snapshot",
    });
    expect(savedStates[1]?.sandboxExpiresAt).toEqual(
      new Date("2026-07-02T12:00:01.000Z"),
    );
  });

  it("exports prior non-sandbox tool calls into tool_calls files", () => {
    const files = getSandboxToolCallFiles([
      {
        createdAt: new Date("2026-07-02T12:00:00.000Z"),
        runId: "run-1",
        event: {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool-call-1",
          toolCallName: "langfuse_getHealth",
        },
      },
      {
        createdAt: new Date("2026-07-02T12:00:00.100Z"),
        runId: "run-1",
        event: {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "tool-call-1",
          delta: '{"projectId":"project-1"}',
        },
      },
      {
        createdAt: new Date("2026-07-02T12:00:00.200Z"),
        runId: "run-1",
        event: {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "tool-call-1",
          content: '{"status":"ok"}',
        },
      },
      {
        createdAt: new Date("2026-07-02T12:00:01.000Z"),
        runId: "run-1",
        event: {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool-call-2",
          toolCallName: "read",
        },
      },
      {
        createdAt: new Date("2026-07-02T12:00:01.100Z"),
        runId: "run-1",
        event: {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "tool-call-2",
          delta: '{"path":"tool_calls/file.json"}',
        },
      },
      {
        createdAt: new Date("2026-07-02T12:00:01.200Z"),
        runId: "run-1",
        event: {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "tool-call-2",
          content: '{"content":"ignored"}',
        },
      },
    ]);

    expect(files).toEqual([
      {
        path: "tool_calls/2026-07-02T12-00-00.000Z_langfuse_getHealth.json",
        content: JSON.stringify(
          {
            request: { projectId: "project-1" },
            response: { status: "ok" },
            error: null,
          },
          null,
          2,
        ),
      },
    ]);
  });

  it("reconnects to a running lambda microvm after recreating the provider", async () => {
    const files = new Map<string, string>();

    lambdaMicrovmsSendMock.mockImplementation(
      async (command: {
        constructor: { name: string };
        input: Record<string, unknown>;
      }) => {
        switch (command.constructor.name) {
          case "RunMicrovmCommand":
            return {
              microvmId: "microvm-1",
              endpoint: "sandbox.example.internal",
              state: "RUNNING",
            };
          case "GetMicrovmCommand":
            return {
              microvmId: command.input.microvmIdentifier,
              endpoint: "sandbox.example.internal",
              state: "RUNNING",
            };
          case "CreateMicrovmAuthTokenCommand":
            return {
              authToken: {
                "X-aws-proxy-auth": "proxy-token",
              },
            };
          default:
            throw new Error(`Unexpected command: ${command.constructor.name}`);
        }
      },
    );

    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === "https://sandbox.example.internal/health") {
        return new Response(null, { status: 200 });
      }

      if (input !== "https://sandbox.example.internal/sandbox") {
        throw new Error(`Unexpected fetch URL: ${input}`);
      }

      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        operation: "read" | "write";
        path?: string;
        content?: string;
      };

      if (payload.operation === "write" && payload.path) {
        files.set(payload.path, payload.content ?? "");
        return Response.json({
          result: {
            path: payload.path,
            bytesWritten: Buffer.byteLength(payload.content ?? "", "utf8"),
          },
        });
      }

      return Response.json({
        result: {
          path: payload.path,
          content: payload.path ? (files.get(payload.path) ?? null) : null,
        },
      });
    });

    let provider = createLambdaMicrovmSandboxProvider({
      imageIdentifier:
        "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox",
    });

    const firstSession = await provider.ensureSession({
      sessionId: null,
      snapshotKey: "snapshots/conversation-1.tar",
    });
    await provider.write({
      sessionId: firstSession.sessionId,
      path: "notes.txt",
      content: "hello",
    });

    provider = createLambdaMicrovmSandboxProvider({
      imageIdentifier:
        "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox",
    });

    const restoredSession = await provider.ensureSession({
      sessionId: firstSession.sessionId,
      snapshotKey: "snapshots/conversation-1.tar",
    });

    await expect(
      provider.read({
        sessionId: restoredSession.sessionId,
        path: "notes.txt",
      }),
    ).resolves.toEqual({ path: "notes.txt", content: "hello" });
    expect(restoredSession.sessionId).toBe(firstSession.sessionId);
    expect(lambdaMicrovmsSendMock).toHaveBeenCalled();
  });
});

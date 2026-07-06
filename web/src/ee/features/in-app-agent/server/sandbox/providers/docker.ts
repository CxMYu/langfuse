import { PassThrough } from "node:stream";

import Docker from "dockerode";

import type { SandboxFile } from "../types";
import type { SandboxSnapshotStore } from "../snapshotStore";
import type { SandboxProvider } from "../types";

type DockerExecResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type DockerSandboxSession = {
  toolCallFiles: ReadonlyArray<SandboxFile>;
};

const DOCKER_SANDBOX_SERVER_PORT = 5000;

export function createDockerSandboxProvider(params: {
  image: string;
  snapshotStore: SandboxSnapshotStore;
}): SandboxProvider {
  const docker = new Docker();
  const sessions = new Map<string, DockerSandboxSession>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const ensureContainer = async (containerId: string) => {
    const container = docker.getContainer(containerId);
    await container.inspect();
    sessions.set(
      containerId,
      sessions.get(containerId) ?? { toolCallFiles: [] },
    );
    return container;
  };

  const createContainer = async (snapshotKey: string) => {
    const container = await docker.createContainer({
      Image: params.image,
      WorkingDir: "/workspace",
      AttachStdout: true,
      AttachStderr: true,
      NetworkDisabled: true,
      Tty: false,
    });
    await container.start();

    const snapshot = await params.snapshotStore.getSnapshot(snapshotKey);
    if (snapshot) {
      await container.putArchive(Buffer.from(snapshot), { path: "/" });
    }

    sessions.set(container.id, { toolCallFiles: [] });
    await waitForSandboxServer(container);
    return container;
  };

  return {
    name: "dangerous-docker",
    async ensureSession({ sessionId, snapshotKey }) {
      if (sessionId) {
        const timer = timers.get(sessionId);
        if (timer) {
          clearTimeout(timer);
          timers.delete(sessionId);
        }

        try {
          await ensureContainer(sessionId);
          await waitForSandboxServer(docker.getContainer(sessionId));
          return { sessionId };
        } catch {
          sessions.delete(sessionId);
        }
      }

      const container = await createContainer(snapshotKey);
      return { sessionId: container.id };
    },
    async syncReadonlyFiles({ sessionId, files }) {
      getSession(sessions, sessionId).toolCallFiles = files;
    },
    async read({ sessionId, path }) {
      const container = await ensureContainer(sessionId);
      return await callSandboxServer(container, {
        operation: "read",
        path,
        toolCallFiles: getSession(sessions, sessionId).toolCallFiles,
      });
    },
    async write({ sessionId, path, content }) {
      const container = await ensureContainer(sessionId);
      return await callSandboxServer(container, {
        operation: "write",
        path,
        content,
        toolCallFiles: getSession(sessions, sessionId).toolCallFiles,
      });
    },
    async edit({ sessionId, path, oldText, newText }) {
      const container = await ensureContainer(sessionId);
      return await callSandboxServer(container, {
        operation: "edit",
        path,
        oldText,
        newText,
        toolCallFiles: getSession(sessions, sessionId).toolCallFiles,
      });
    },
    async bash({ sessionId, command, timeoutMs }) {
      const container = await ensureContainer(sessionId);
      return await callSandboxServer(container, {
        operation: "bash",
        command,
        ...(timeoutMs ? { timeoutMs } : {}),
        toolCallFiles: getSession(sessions, sessionId).toolCallFiles,
      });
    },
    async scheduleSuspension({ sessionId, snapshotKey, expiresAt }) {
      const existingTimer = timers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const delayMs = Math.max(0, expiresAt.getTime() - Date.now());
      const timer = setTimeout(async () => {
        try {
          const container = await ensureContainer(sessionId);
          const archive = await container.getArchive({ path: "/workspace" });
          await params.snapshotStore.putSnapshot(
            snapshotKey,
            await readStreamToUint8Array(archive),
          );
          await container
            .remove({ force: true, v: true })
            .catch(() => undefined);
        } finally {
          sessions.delete(sessionId);
          timers.delete(sessionId);
        }
      }, delayMs);
      timers.set(sessionId, timer);
    },
    async terminateSession({ sessionId }) {
      const existingTimer = timers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timers.delete(sessionId);
      }

      sessions.delete(sessionId);

      await docker
        .getContainer(sessionId)
        .remove({ force: true, v: true })
        .catch(() => undefined);
    },
  };
}

async function waitForSandboxServer(container: Docker.Container) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 30_000) {
    try {
      const result = await execJsonInContainer(container, [
        "node",
        "-e",
        `
          (async () => {
            const response = await fetch("http://127.0.0.1:${DOCKER_SANDBOX_SERVER_PORT}/health");
            if (!response.ok) {
              process.stderr.write(await response.text());
              process.exit(1);
            }
            process.stdout.write(await response.text());
          })().catch((error) => {
            process.stderr.write(error instanceof Error ? error.message : String(error));
            process.exit(1);
          });
        `,
      ]);

      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "ok"
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Sandbox server did not become ready");
}

async function callSandboxServer(
  container: Docker.Container,
  payload: Record<string, unknown>,
) {
  const result = await execJsonInContainer(container, [
    "node",
    "-e",
    `
      (async () => {
        const payload = JSON.parse(process.argv[1]);
        const response = await fetch("http://127.0.0.1:${DOCKER_SANDBOX_SERVER_PORT}/sandbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        if (!response.ok) {
          process.stderr.write(text);
          process.exit(1);
        }
        process.stdout.write(text);
      })().catch((error) => {
        process.stderr.write(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    `,
    JSON.stringify(payload),
  ]);

  if (result && typeof result === "object" && "result" in result) {
    return result.result;
  }

  return result;
}

function getSession(
  sessions: Map<string, DockerSandboxSession>,
  sessionId: string,
) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Missing sandbox session: ${sessionId}`);
  }

  return session;
}

async function execJsonInContainer(
  container: Docker.Container,
  cmd: string[],
  timeoutMs?: number,
) {
  const result = await execInContainer(container, cmd, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || result.stdout || "Container command failed",
    );
  }
  return JSON.parse(result.stdout || "null") as unknown;
}

async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  timeoutMs?: number,
): Promise<DockerExecResult> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/workspace",
  });
  const stream = await exec.start({ Tty: false });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  container.modem.demuxStream(stream, stdout, stderr);

  const timeoutId = timeoutMs
    ? setTimeout(
        () =>
          stream.destroy(
            new Error(`Sandbox command timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      )
    : undefined;

  try {
    const [stdoutBytes, stderrBytes, inspect] = await Promise.all([
      readStreamToUint8Array(stdout),
      readStreamToUint8Array(stderr),
      waitForStreamEnd(stream).then(() => exec.inspect()),
    ]);

    return {
      exitCode: inspect.ExitCode ?? 1,
      stdout: Buffer.from(stdoutBytes).toString("utf8"),
      stderr: Buffer.from(stderrBytes).toString("utf8"),
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function readStreamToUint8Array(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function waitForStreamEnd(stream: NodeJS.ReadableStream) {
  await new Promise<void>((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
    stream.once("close", resolve);
  });
}

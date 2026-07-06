import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { z } from "zod";

type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: string;
  completedAt: string;
};

type SandboxOperation = z.infer<typeof SandboxOperationSchema>;

const SandboxFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const ReadOperationSchema = z.object({
  operation: z.literal("read"),
  path: z.string(),
  toolCallFiles: z.array(SandboxFileSchema).optional(),
});

const WriteOperationSchema = z.object({
  operation: z.literal("write"),
  path: z.string(),
  content: z.string(),
  toolCallFiles: z.array(SandboxFileSchema).optional(),
});

const EditOperationSchema = z.object({
  operation: z.literal("edit"),
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
  toolCallFiles: z.array(SandboxFileSchema).optional(),
});

const BashOperationSchema = z.object({
  operation: z.literal("bash"),
  command: z.string(),
  timeoutMs: z.number().finite().optional(),
  toolCallFiles: z.array(SandboxFileSchema).optional(),
});

const SandboxOperationSchema = z.discriminatedUnion("operation", [
  ReadOperationSchema,
  WriteOperationSchema,
  EditOperationSchema,
  BashOperationSchema,
]);

type SandboxFile = z.infer<typeof SandboxFileSchema>;
type ReadOperation = z.infer<typeof ReadOperationSchema>;
type WriteOperation = z.infer<typeof WriteOperationSchema>;
type EditOperation = z.infer<typeof EditOperationSchema>;
type BashOperation = z.infer<typeof BashOperationSchema>;

const BRIDGE_PORT = Number(process.env.PORT ?? 5000);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const TOOL_CALLS_ROOT = path.join(WORKSPACE_ROOT, "tool_calls");
let requestCounter = 0;

const server = createServer(async (request, response) => {
  const requestId = `req-${++requestCounter}`;
  const startedAt = Date.now();

  try {
    logSandboxServer("request.start", {
      requestId,
      method: request.method ?? "UNKNOWN",
      url: request.url ?? "",
    });

    if (request.method === "GET" && request.url === "/health") {
      logSandboxServer("health.ok", { requestId });
      sendJson(response, 200, { status: "ok" });
      logSandboxServer("request.end", {
        requestId,
        statusCode: 200,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (request.method === "POST" && request.url === "/sandbox") {
      const body = SandboxOperationSchema.parse(await readJsonBody(request));
      logSandboxServer("sandbox.request", {
        requestId,
        operation: summarizeOperation(body),
      });
      await syncToolCallFiles(body.toolCallFiles, requestId);

      switch (body.operation) {
        case "read":
          sendJson(response, 200, await readOperation(body, requestId));
          logSandboxServer("request.end", {
            requestId,
            statusCode: 200,
            durationMs: Date.now() - startedAt,
          });
          return;
        case "write":
          sendJson(response, 200, await writeOperation(body, requestId));
          logSandboxServer("request.end", {
            requestId,
            statusCode: 200,
            durationMs: Date.now() - startedAt,
          });
          return;
        case "edit":
          sendJson(response, 200, await editOperation(body, requestId));
          logSandboxServer("request.end", {
            requestId,
            statusCode: 200,
            durationMs: Date.now() - startedAt,
          });
          return;
        case "bash":
          sendJson(response, 200, await bashOperation(body, requestId));
          logSandboxServer("request.end", {
            requestId,
            statusCode: 200,
            durationMs: Date.now() - startedAt,
          });
          return;
        default:
          sendJson(response, 400, { error: "Unsupported sandbox operation" });
          logSandboxServer("request.end", {
            requestId,
            statusCode: 400,
            durationMs: Date.now() - startedAt,
          });
          return;
      }
    }

    sendJson(response, 404, { error: "Not found" });
    logSandboxServer("request.end", {
      requestId,
      statusCode: 404,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logSandboxServer("request.error", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(response, 500, {
      error:
        error instanceof Error ? error.message : "Unknown sandbox server error",
    });
  }
});

server.listen(BRIDGE_PORT, () => {
  logSandboxServer("server.listening", {
    port: BRIDGE_PORT,
    workspaceRoot: WORKSPACE_ROOT,
  });
});

async function syncToolCallFiles(toolCallFiles: unknown, requestId: string) {
  await rm(TOOL_CALLS_ROOT, { recursive: true, force: true });

  if (!toolCallFiles) {
    logSandboxServer("toolCalls.sync", { requestId, fileCount: 0 });
    return;
  }

  const files = z.array(SandboxFileSchema).parse(toolCallFiles);
  logSandboxServer("toolCalls.sync", {
    requestId,
    fileCount: files.length,
    paths: files.map((file) => file.path),
  });

  for (const file of files) {
    const filePath = resolveSandboxPath(file.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
    await chmod(filePath, 0o444);
  }
}

async function readOperation(body: ReadOperation, requestId: string) {
  const filePath = resolveSandboxPath(body.path);

  try {
    const content = await readFile(filePath, "utf8");
    logSandboxServer("read.complete", {
      requestId,
      path: filePath,
      bytesRead: Buffer.byteLength(content, "utf8"),
    });
    return { result: { path: filePath, content } };
  } catch (error) {
    if (isMissingFileError(error)) {
      logSandboxServer("read.missing", { requestId, path: filePath });
      return { result: { path: filePath, content: null } };
    }

    throw error;
  }
}

async function writeOperation(body: WriteOperation, requestId: string) {
  const filePath = resolveSandboxPath(body.path);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body.content, "utf8");

  const bytesWritten = Buffer.byteLength(body.content, "utf8");
  logSandboxServer("write.complete", {
    requestId,
    path: filePath,
    bytesWritten,
  });

  return {
    result: {
      path: filePath,
      bytesWritten,
    },
  };
}

async function editOperation(body: EditOperation, requestId: string) {
  const filePath = resolveSandboxPath(body.path);

  let current = "";
  try {
    current = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const replaced = current.includes(body.oldText);
  if (replaced) {
    await writeFile(
      filePath,
      current.replace(body.oldText, body.newText),
      "utf8",
    );
  }

  logSandboxServer("edit.complete", {
    requestId,
    path: filePath,
    replaced,
    oldTextLength: body.oldText.length,
    newTextLength: body.newText.length,
  });

  return { result: { path: filePath, replaced } };
}

async function bashOperation(body: BashOperation, requestId: string) {
  return {
    result: await runCommand(body.command, body.timeoutMs, requestId),
  };
}

function runCommand(command: string, timeoutMs?: number, requestId?: string) {
  return new Promise<BashResult>((resolve, reject) => {
    const child = spawn("sh", ["-lc", command], { cwd: WORKSPACE_ROOT });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = new Date().toISOString();

    logSandboxServer("bash.start", {
      requestId,
      pid: child.pid ?? null,
      timeoutMs: timeoutMs ?? null,
      command: summarizeCommand(command),
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        logSandboxServer("bash.error", {
          requestId,
          pid: child.pid ?? null,
          command: summarizeCommand(command),
          error: error.message,
        });
        reject(error);
      }
    });

    const timeoutId =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            child.kill("SIGKILL");
            const result = {
              stdout,
              stderr: `${stderr}Sandbox command timed out after ${timeoutMs}ms`,
              exitCode: 124,
              startedAt,
              completedAt: new Date().toISOString(),
            };
            logSandboxServer("bash.timeout", {
              requestId,
              pid: child.pid ?? null,
              command: summarizeCommand(command),
              timeoutMs,
              stdoutBytes: Buffer.byteLength(stdout, "utf8"),
              stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
            });
            resolve(result);
          }, timeoutMs);

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const result = {
        stdout,
        stderr,
        exitCode: code ?? 1,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      logSandboxServer("bash.complete", {
        requestId,
        pid: child.pid ?? null,
        command: summarizeCommand(command),
        exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
      });
      resolve(result);
    });
  });
}

function logSandboxServer(event: string, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[sandbox] ${new Date().toISOString()} ${event}${payload}`);
}

function summarizeOperation(body: SandboxOperation) {
  switch (body.operation) {
    case "read":
      return { operation: body.operation, path: body.path };
    case "write":
      return {
        operation: body.operation,
        path: body.path,
        contentBytes: Buffer.byteLength(body.content, "utf8"),
      };
    case "edit":
      return {
        operation: body.operation,
        path: body.path,
        oldTextLength: body.oldText.length,
        newTextLength: body.newText.length,
      };
    case "bash":
      return {
        operation: body.operation,
        timeoutMs: body.timeoutMs ?? null,
        command: summarizeCommand(body.command),
      };
  }
}

function summarizeCommand(command: string) {
  return command.length <= 500 ? command : `${command.slice(0, 500)}...`;
}

function resolveSandboxPath(requestPath: string) {
  const candidate = path.isAbsolute(requestPath)
    ? requestPath
    : path.join(WORKSPACE_ROOT, requestPath);
  const normalized = path.resolve(candidate);

  if (
    normalized === WORKSPACE_ROOT ||
    normalized.startsWith(`${WORKSPACE_ROOT}${path.sep}`)
  ) {
    return normalized;
  }

  throw new Error(`Sandbox path escapes workspace: ${requestPath}`);
}

function readJsonBody(request: IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer | string) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: unknown,
) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function isMissingFileError(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

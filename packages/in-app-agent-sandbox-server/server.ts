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

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "POST" && request.url === "/sandbox") {
      const body = SandboxOperationSchema.parse(await readJsonBody(request));
      await syncToolCallFiles(body.toolCallFiles);

      switch (body.operation) {
        case "read":
          sendJson(response, 200, await readOperation(body));
          return;
        case "write":
          sendJson(response, 200, await writeOperation(body));
          return;
        case "edit":
          sendJson(response, 200, await editOperation(body));
          return;
        case "bash":
          sendJson(response, 200, await bashOperation(body));
          return;
        default:
          sendJson(response, 400, { error: "Unsupported sandbox operation" });
          return;
      }
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      error:
        error instanceof Error ? error.message : "Unknown sandbox server error",
    });
  }
});

server.listen(BRIDGE_PORT, () => {
  console.log(`In-app agent sandbox server listening on ${BRIDGE_PORT}`);
});

async function syncToolCallFiles(toolCallFiles: unknown) {
  await rm(TOOL_CALLS_ROOT, { recursive: true, force: true });

  if (!toolCallFiles) {
    return;
  }

  const files = z.array(SandboxFileSchema).parse(toolCallFiles);

  for (const file of files) {
    const filePath = resolveSandboxPath(file.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
    await chmod(filePath, 0o444);
  }
}

async function readOperation(body: ReadOperation) {
  const filePath = resolveSandboxPath(body.path);

  try {
    const content = await readFile(filePath, "utf8");
    return { result: { path: filePath, content } };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { result: { path: filePath, content: null } };
    }

    throw error;
  }
}

async function writeOperation(body: WriteOperation) {
  const filePath = resolveSandboxPath(body.path);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body.content, "utf8");

  return {
    result: {
      path: filePath,
      bytesWritten: Buffer.byteLength(body.content, "utf8"),
    },
  };
}

async function editOperation(body: EditOperation) {
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

  return { result: { path: filePath, replaced } };
}

async function bashOperation(body: BashOperation) {
  return {
    result: await runCommand(body.command, body.timeoutMs),
  };
}

function runCommand(command: string, timeoutMs?: number) {
  return new Promise<BashResult>((resolve, reject) => {
    const child = spawn("sh", ["-lc", command], { cwd: WORKSPACE_ROOT });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = new Date().toISOString();

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
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
            resolve({
              stdout,
              stderr: `${stderr}Sandbox command timed out after ${timeoutMs}ms`,
              exitCode: 124,
              startedAt,
              completedAt: new Date().toISOString(),
            });
          }, timeoutMs);

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    });
  });
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
    Boolean(error) &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

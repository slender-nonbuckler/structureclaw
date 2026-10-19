/** Local, chat-only client for the documented Codex app-server stdio protocol. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type JsonObject = Record<string, unknown>;
type RpcNotification = { method: string; params: JsonObject };

const RPC_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60_000;

// These overrides affect only this child process. No auth files are inspected.
export const CODEX_CHAT_ARGS = [
  'app-server', '--listen', 'stdio://', '--strict-config',
  '-c', 'features.shell_tool=false',
  '-c', 'features.apps=false',
  '-c', 'features.plugins=false',
  '-c', 'features.hooks=false',
  '-c', 'features.multi_agent=false',
  '-c', 'tools.view_image=false',
  '-c', 'tools.web_search=false',
  '-c', 'web_search="disabled"',
  '-c', 'mcp_servers={}',
] as const;

const UNSAFE_ITEMS = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'webSearch', 'imageView', 'collabToolCall', 'functionCallOutput',
]);

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : {};
}

function abortError(): Error {
  const error = new Error('Codex chat turn cancelled');
  error.name = 'AbortError';
  return error;
}

export interface CodexRpcTransport {
  request(method: string, params: JsonObject, timeoutMs?: number): Promise<JsonObject>;
  notify(method: string, params: JsonObject): void;
  nextNotification(signal?: AbortSignal, timeoutMs?: number): Promise<RpcNotification>;
  close(): Promise<void>;
}

export class CodexAppServerProcess implements CodexRpcTransport {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly notifications: RpcNotification[] = [];
  private waiter?: { resolve: (value: RpcNotification) => void; reject: (error: Error) => void };
  private failure?: Error;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.receive(line));
    child.on('error', () => this.fail(new Error('Codex app-server could not start')));
    child.on('close', () => this.fail(new Error('Codex app-server exited')));
    // Never forward stderr: it may contain account or local configuration details.
    child.stderr.resume();
  }

  static start(disabledMcpServers: string[] = []): CodexAppServerProcess {
    const windows = process.platform === 'win32';
    for (const name of disabledMcpServers) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error('Codex MCP server name cannot be safely overridden');
      }
    }
    const args = [
      ...CODEX_CHAT_ARGS,
      ...disabledMcpServers.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
    ];
    const child = spawn(windows ? 'codex.cmd' : 'codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: windows, // Windows npm CLI shim; every argument above is a constant.
    });
    return new CodexAppServerProcess(child);
  }

  private receive(line: string): void {
    let message: JsonObject;
    try {
      message = record(JSON.parse(line));
    } catch {
      this.fail(new Error('Codex app-server returned invalid JSON'));
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error('Codex request failed'));
      } else {
        pending.resolve(record(message.result));
      }
      return;
    }
    if (typeof message.method === 'string' && message.id !== undefined) {
      // This chat-only client never grants server-initiated tool or approval requests.
      this.fail(new Error('Codex requested an unsupported client action'));
      return;
    }
    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: record(message.params) };
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter.resolve(notification);
      } else {
        this.notifications.push(notification);
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.waiter?.reject(error);
    this.waiter = undefined;
  }

  private send(message: JsonObject): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: JsonObject, timeoutMs = RPC_TIMEOUT_MS): Promise<JsonObject> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: JsonObject): void {
    this.send({ method, params });
  }

  async nextNotification(signal?: AbortSignal, timeoutMs = TURN_TIMEOUT_MS): Promise<RpcNotification> {
    if (signal?.aborted) throw abortError();
    if (this.notifications.length > 0) return this.notifications.shift()!;
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Codex turn timed out'));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiter = undefined;
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiter = {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      };
    });
  }

  async close(): Promise<void> {
    this.fail(new Error('Codex app-server closed'));
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    if (process.platform === 'win32' && this.child.pid) {
      // The npm CLI shim runs under cmd.exe; terminate its process tree too.
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        });
        killer.on('error', () => resolve());
        killer.on('close', () => resolve());
      });
    }
    this.child.kill();
  }
}

export interface CodexChatTurnInput {
  message: string;
  threadId?: string;
  signal?: AbortSignal;
  onToken: (token: string) => void;
}

export interface CodexChatTurnResult {
  threadId: string;
  response: string;
}

export type CodexTransportFactory = (disabledMcpServers: string[]) => CodexRpcTransport;

export class CodexChatService {
  constructor(private readonly transportFactory: CodexTransportFactory = (names) => CodexAppServerProcess.start(names)) {}

  private async prepare(transport: CodexRpcTransport): Promise<JsonObject[]> {
    await transport.request('initialize', {
      clientInfo: { name: 'structureclaw_local_chat', title: 'StructureClaw Local Chat', version: '0.1.0' },
    });
    transport.notify('initialized', {});
    const account = await transport.request('account/read', { refreshToken: false });
    if (record(account.account).type !== 'chatgpt') {
      throw new Error('Codex is not signed in with ChatGPT');
    }
    const mcp = await transport.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' });
    if (!Array.isArray(mcp.data) || mcp.nextCursor != null) {
      throw new Error('Codex MCP inventory could not be verified');
    }
    return mcp.data.map(record);
  }

  async runTurn(input: CodexChatTurnInput): Promise<CodexChatTurnResult> {
    const emptyCwd = await mkdtemp(join(tmpdir(), 'structureclaw-codex-chat-'));
    let transport: CodexRpcTransport | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    try {
      transport = this.transportFactory([]);
      const inventory = await this.prepare(transport);
      if (inventory.length > 0) {
        const names = inventory.map((server) => server.name);
        if (names.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name))) {
          throw new Error('Codex MCP server name cannot be safely overridden');
        }
        await transport.close();
        transport = this.transportFactory(names as string[]);
        const restrictedInventory = await this.prepare(transport);
        if (restrictedInventory.some((server) => Object.keys(record(server.tools)).length > 0 || server.toolsError)) {
          throw new Error('Codex chat could not disable MCP tools');
        }
      }
      if (input.signal?.aborted) throw abortError();

      const thread = await transport.request(input.threadId ? 'thread/resume' : 'thread/start', {
        ...(input.threadId ? { threadId: input.threadId, excludeTurns: true } : { ephemeral: false }),
        modelProvider: 'openai',
        cwd: emptyCwd,
        sandbox: 'read-only',
        approvalPolicy: 'never',
      });
      threadId = record(thread.thread).id as string | undefined;
      if (!threadId || (input.threadId && threadId !== input.threadId)) {
        throw new Error('Codex did not return the expected thread');
      }
      const provider = thread.modelProvider ?? record(thread.thread).modelProvider;
      if (provider !== 'openai') throw new Error('Codex did not select the OpenAI provider');
      if (input.signal?.aborted) throw abortError();

      const started = await transport.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.message }],
        cwd: emptyCwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      });
      turnId = record(started.turn).id as string | undefined;
      if (!turnId) throw new Error('Codex did not return a turn ID');

      let streamedText = '';
      let finalText = '';
      while (true) {
        const event = await transport.nextNotification(input.signal);
        if (event.params.threadId !== threadId) continue;
        if (event.params.turnId && event.params.turnId !== turnId) continue;
        if (event.method === 'item/started' || event.method === 'item/completed') {
          const item = record(event.params.item);
          if (UNSAFE_ITEMS.has(String(item.type))) {
            throw new Error('Codex attempted a tool in chat-only mode');
          }
          if (event.method === 'item/completed' && item.type === 'agentMessage'
            && typeof item.text === 'string' && item.text.length > 0) {
            finalText = item.text;
          }
        }
        if (event.method === 'item/agentMessage/delta' && typeof event.params.delta === 'string') {
          streamedText += event.params.delta;
          input.onToken(event.params.delta);
        }
        if (event.method === 'error') {
          throw new Error('Codex turn failed');
        }
        if (event.method === 'turn/completed') {
          const turn = record(event.params.turn);
          if (turn.id !== turnId || turn.status !== 'completed') {
            throw new Error(`Codex turn ${String(turn.status)}`);
          }
          const response = finalText || streamedText;
          if (!response.trim()) throw new Error('Codex turn produced no text');
          return { threadId, response };
        }
      }
    } catch (error) {
      if (transport && threadId && turnId) {
        try {
          await transport.request('turn/interrupt', { threadId, turnId }, 2_000);
        } catch { /* process may already have exited */ }
      }
      throw error;
    } finally {
      await transport?.close();
      await rm(emptyCwd, { recursive: true, force: true });
    }
  }
}

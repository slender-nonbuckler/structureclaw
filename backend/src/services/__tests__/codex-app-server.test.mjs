import { describe, expect, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServerProcess, CodexChatService, CODEX_CHAT_ARGS } from '../../../dist/services/codex-app-server.js';
import { codexSseData, isLocalCodexRequest, priorThreadId } from '../../../dist/api/codex-chat.js';

class FakeTransport {
  constructor(events = [], options = {}) {
    this.events = [...events];
    this.options = options;
    this.calls = [];
    this.closed = false;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'account/read') return { account: { type: this.options.accountType ?? 'chatgpt' } };
    if (method === 'mcpServerStatus/list') return { data: this.options.mcp ?? [], nextCursor: null };
    if (method === 'thread/start') return { thread: { id: 'thread-1', modelProvider: 'openai' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, modelProvider: 'openai' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected method: ${method}`);
  }

  notify(method, params) { this.calls.push({ method, params }); }

  async nextNotification(signal) {
    if (signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    if (this.events.length === 0) throw new Error('No more fake events');
    return this.events.shift();
  }

  async close() { this.closed = true; }
}

const event = (method, params = {}) => ({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } });

describe('Codex chat-only runtime', () => {
  test('initializes, streams text, completes, and cleans up', async () => {
    const fake = new FakeTransport([
      event('item/agentMessage/delta', { delta: 'Hello' }),
      event('item/agentMessage/delta', { delta: ' world' }),
      event('item/completed', { item: { type: 'agentMessage', text: 'Hello world' } }),
      event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }),
    ]);
    const tokens = [];
    const result = await new CodexChatService(() => fake).runTurn({ message: 'Hi', onToken: (token) => tokens.push(token) });
    expect(result).toEqual({ threadId: 'thread-1', response: 'Hello world' });
    expect(tokens).toEqual(['Hello', ' world']);
    expect(fake.calls.map((call) => call.method)).toEqual([
      'initialize', 'initialized', 'account/read', 'mcpServerStatus/list', 'thread/start', 'turn/start',
    ]);
    expect(fake.calls.find((call) => call.method === 'thread/start').params).toMatchObject({
      sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false, modelProvider: 'openai',
    });
    expect(fake.calls.find((call) => call.method === 'turn/start').params.sandboxPolicy).toEqual({
      type: 'readOnly', networkAccess: false,
    });
    expect(fake.closed).toBe(true);
  });

  test('resumes an existing Codex thread for a later message', async () => {
    const fake = new FakeTransport([
      event('item/agentMessage/delta', { delta: 'Follow up answer' }),
      event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }),
    ]);
    await new CodexChatService(() => fake).runTurn({ message: 'Follow up', threadId: 'thread-1', onToken: () => {} });
    expect(fake.calls.some((call) => call.method === 'thread/resume' && call.params.threadId === 'thread-1')).toBe(true);
    expect(fake.calls.some((call) => call.method === 'thread/start')).toBe(false);
    expect(fake.closed).toBe(true);
  });

  test.each([
    [{ accountType: 'apiKey' }, 'not signed in with ChatGPT'],
    [{ mcp: [{ name: 'existing-server', tools: { unsafe: {} } }] }, 'could not disable MCP tools'],
  ])('fails closed before starting a turn when preflight fails', async (options, message) => {
    const fake = new FakeTransport([], options);
    await expect(new CodexChatService(() => fake).runTurn({ message: 'Hi', onToken: () => {} })).rejects.toThrow(message);
    expect(fake.calls.some((call) => call.method === 'turn/start')).toBe(false);
    expect(fake.closed).toBe(true);
  });

  test('uses one connection and verifies that node_repl has zero tools', async () => {
    const restricted = new FakeTransport([
      event('item/agentMessage/delta', { delta: 'Hello' }),
      event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }),
    ], { mcp: [{ name: 'node_repl', tools: {} }] });
    let launches = 0;
    const service = new CodexChatService(() => {
      launches += 1;
      return restricted;
    });
    await service.runTurn({ message: 'Hi', onToken: () => {} });
    expect(launches).toBe(1);
    expect(restricted.calls.some((call) => call.method === 'mcpServerStatus/list')).toBe(true);
    expect(restricted.closed).toBe(true);
  });

  test('rejects tool activity and interrupts the turn', async () => {
    const fake = new FakeTransport([event('item/started', { item: { type: 'commandExecution' } })]);
    await expect(new CodexChatService(() => fake).runTurn({ message: 'Hi', onToken: () => {} })).rejects.toThrow('attempted a tool');
    expect(fake.calls.some((call) => call.method === 'turn/interrupt')).toBe(true);
    expect(fake.closed).toBe(true);
  });

  test('surfaces failed turn errors and interrupts', async () => {
    const fake = new FakeTransport([event('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'limit reached' } } })]);
    await expect(new CodexChatService(() => fake).runTurn({ message: 'Hi', onToken: () => {} })).rejects.toThrow('Codex turn failed');
    expect(fake.closed).toBe(true);
  });

  test('cancels a turn through the documented interrupt request', async () => {
    const controller = new AbortController();
    const fake = new FakeTransport([event('item/agentMessage/delta', { delta: 'First' })]);
    await expect(new CodexChatService(() => fake).runTurn({
      message: 'Hi', signal: controller.signal, onToken: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls.some((call) => call.method === 'turn/interrupt')).toBe(true);
    expect(fake.closed).toBe(true);
  });

  test('does not start a turn when the request was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeTransport();
    await expect(new CodexChatService(() => fake).runTurn({
      message: 'Hi', signal: controller.signal, onToken: () => {},
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls.some((call) => call.method === 'thread/start' || call.method === 'turn/start')).toBe(false);
    expect(fake.closed).toBe(true);
  });

  test('launch settings disable command and external tools', () => {
    expect(CODEX_CHAT_ARGS).toContain('features.shell_tool=false');
    expect(CODEX_CHAT_ARGS).toContain('features.apps=false');
    expect(CODEX_CHAT_ARGS).toContain('tools.view_image=false');
    expect(CODEX_CHAT_ARGS).toContain('mcp_servers.node_repl.enabled=false');
  });
});

describe('Codex stdio connection', () => {
  function childProcess() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('close', 0); return true; };
    return child;
  }

  test('matches JSON-RPC replies and notifications, then closes', async () => {
    const child = childProcess();
    const client = new CodexAppServerProcess(child);
    child.stdin.once('data', (buffer) => {
      const request = JSON.parse(buffer.toString());
      expect(request.method).toBe('initialize');
      child.stdout.write(`${JSON.stringify({ id: request.id, result: { ready: true } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } })}\n`);
    });
    await expect(client.request('initialize', {})).resolves.toEqual({ ready: true });
    await expect(client.nextNotification()).resolves.toMatchObject({ method: 'turn/completed' });
    await client.close();
    expect(child.exitCode).toBe(0);
  });

  test('rejects malformed protocol output', async () => {
    const child = childProcess();
    const client = new CodexAppServerProcess(child);
    child.stdout.write('not json\n');
    await expect(client.request('initialize', {})).rejects.toThrow('invalid JSON');
    await client.close();
  });

  test('reports an exit code and sanitized stderr category', async () => {
    const child = childProcess();
    const client = new CodexAppServerProcess(child);
    const pending = client.request('initialize', {});
    child.stderr.write('node_repl startup failed; token=private-value');
    child.emit('close', 1, null);
    await expect(pending).rejects.toThrow('Codex app-server exited (code 1; stderr mentions MCP)');
    await expect(pending).rejects.not.toThrow('private-value');
    await client.close();
  });
});

describe('Codex local access', () => {
  const local = { bindHost: '127.0.0.1', peerAddress: '::ffff:127.0.0.1', hostHeader: 'localhost:31415' };
  test('allows direct loopback requests', () => {
    expect(isLocalCodexRequest(local)).toBe(true);
  });
  test.each([
    { bindHost: '0.0.0.0' },
    { peerAddress: '192.168.1.20' },
    { hostHeader: 'remote.example:31415' },
    { origin: 'https://remote.example' },
    { forwardedFor: '192.168.1.20' },
  ])('rejects nonlocal or forwarded access', (override) => {
    expect(isLocalCodexRequest({ ...local, ...override })).toBe(false);
  });
  test('uses only a Codex conversation marker for continuation', () => {
    expect(priorThreadId([{ role: 'assistant', metadata: { runtime: 'codex-chat', codexThreadId: 'thread-1' } }])).toBe('thread-1');
    expect(priorThreadId([{ role: 'assistant', metadata: { codexThreadId: 'thread-1' } }])).toBeUndefined();
  });

  test('formats translated text events for the existing SSE contract', () => {
    expect(codexSseData({ type: 'token', content: 'Hello' }))
      .toBe('data: {"type":"token","content":"Hello"}\n\n');
    expect(codexSseData({ type: 'result', content: { response: 'Hello', mode: 'conversation', success: true } }))
      .toBe('data: {"type":"result","content":{"response":"Hello","mode":"conversation","success":true}}\n\n');
  });
});

/** Opt-in chat-only Codex endpoint. Never register a sign-in or token endpoint. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/index.js';
import { CodexChatService } from '../services/codex-app-server.js';
import { ConversationService } from '../services/conversation.js';
import { prisma } from '../utils/database.js';

const inputSchema = z.object({
  message: z.string().min(1).max(10000),
  conversationId: z.string().min(1).optional(),
  locale: z.enum(['en', 'zh']).optional(),
}).strict();

const activeConversations = new Set<string>();

function localized(locale: 'en' | 'zh', en: string, zh: string): string {
  return locale === 'zh' ? zh : en;
}

function isLoopback(value: string | undefined): boolean {
  const host = value?.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
}

export function isLocalCodexRequest(input: {
  bindHost: string;
  peerAddress?: string;
  hostHeader?: string;
  origin?: string;
  forwarded?: string;
  forwardedFor?: string;
  forwardedHost?: string;
}): boolean {
  if (!isLoopback(input.bindHost) || !isLoopback(input.peerAddress)) return false;
  if (input.forwarded || input.forwardedFor || input.forwardedHost) return false;
  try {
    if (!isLoopback(new URL(`http://${input.hostHeader}`).hostname)) return false;
    if (input.origin && !isLoopback(new URL(input.origin).hostname)) return false;
  } catch {
    return false;
  }
  return true;
}

export function priorThreadId(messages: Array<{ role: string; metadata: unknown }>): string | undefined {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant || !lastAssistant.metadata || typeof lastAssistant.metadata !== 'object') return undefined;
  const metadata = lastAssistant.metadata as Record<string, unknown>;
  return metadata.runtime === 'codex-chat' && typeof metadata.codexThreadId === 'string'
    ? metadata.codexThreadId : undefined;
}

export function codexSseData(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export async function codexChatRoutes(fastify: FastifyInstance) {
  const service = new CodexChatService();
  const conversations = new ConversationService();

  fastify.post('/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const headerLocale = request.headers['accept-language']?.startsWith('zh') ? 'zh' : 'en';
    if (!isLocalCodexRequest({
      bindHost: config.host,
      peerAddress: request.socket.remoteAddress,
      hostHeader: request.headers.host,
      origin: request.headers.origin,
      forwarded: request.headers.forwarded,
      forwardedFor: request.headers['x-forwarded-for'] as string | undefined,
      forwardedHost: request.headers['x-forwarded-host'] as string | undefined,
    })) {
      return reply.code(403).send({ error: localized(headerLocale,
        'Codex local chat requires direct loopback access.', 'Codex 本地聊天仅允许直接通过本机回环地址访问。') });
    }

    const body = inputSchema.parse(request.body);
    const existing = body.conversationId
      ? await prisma.conversation.findUnique({
        where: { id: body.conversationId },
        include: { messages: { orderBy: { createdAt: 'asc' }, select: { role: true, metadata: true } } },
      }) : null;
    if (body.conversationId && !existing) {
      return reply.code(404).send({ error: localized(body.locale ?? headerLocale,
        'Conversation not found.', '未找到该对话。') });
    }
    const messages = existing?.messages ?? [];
    const threadId = priorThreadId(messages);
    if (messages.length > 0 && !threadId) {
      return reply.code(409).send({ error: localized(body.locale ?? headerLocale,
        'This conversation did not start in Codex chat.', '此对话不是通过 Codex 聊天创建的。') });
    }
    const conversationId = existing?.id ?? (await conversations.createConversation({
      title: body.message.slice(0, 48), type: 'general', locale: body.locale,
    })).id;
    if (activeConversations.has(conversationId)) {
      return reply.code(409).send({ error: localized(body.locale ?? headerLocale,
        'A Codex turn is already running for this conversation.', '此对话已有正在运行的 Codex 回合。') });
    }
    activeConversations.add(conversationId);
    const traceId = randomUUID();

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    request.socket.on('close', onClose);
    reply.raw.on('close', onClose);
    const send = (chunk: unknown) => {
      if (!abortController.signal.aborted) reply.raw.write(codexSseData(chunk));
    };
    try {
      send({ type: 'start', content: { conversationId, traceId, mode: 'conversation' } });
      const result = await service.runTurn({
        message: body.message,
        threadId,
        signal: abortController.signal,
        onToken: (token) => send({ type: 'token', content: token }),
      });
      if (abortController.signal.aborted) return;

      const timestamp = Date.now();
      await prisma.message.createMany({ data: [
        { conversationId, role: 'user', content: body.message, createdAt: new Date(timestamp), metadata: { traceId, runtime: 'codex-chat' } },
        { conversationId, role: 'assistant', content: result.response.slice(0, 10000), createdAt: new Date(timestamp + 1), metadata: { traceId, runtime: 'codex-chat', codexThreadId: result.threadId } },
      ] });
      send({ type: 'result', content: { response: result.response, mode: 'conversation', success: true } });
      send({ type: 'done' });
      reply.raw.write('data: [DONE]\n\n');
    } catch (error) {
      if (!abortController.signal.aborted) {
        request.log.warn({ err: error }, 'Codex local chat failed');
        send({ type: 'error', error: localized(body.locale ?? headerLocale,
          'Codex chat failed. Check the local backend log.', 'Codex 聊天失败，请查看本地后端日志。') });
        reply.raw.write('data: [DONE]\n\n');
      }
    } finally {
      activeConversations.delete(conversationId);
      request.socket.off('close', onClose);
      reply.raw.off('close', onClose);
      reply.raw.end();
    }
  });
}

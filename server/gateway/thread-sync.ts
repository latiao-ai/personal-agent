import type { DatabaseSync } from "node:sqlite";

export interface GatewayThreadSink {
  hasThread(botId: string, threadId: string): boolean;
  createThread(botId: string, title: string): string | null;
  appendUserMessage(
    threadId: string,
    input: { text: string; source: "feishu" | "weixin"; senderId: string; at: number },
  ): void;
  appendAssistantMessage(threadId: string, input: { text: string; at: number }): void;
  appendFailureMessage(threadId: string, input: { error: string; at: number }): void;
  setThinking?(botId: string, threadId: string, thinking: boolean): void;
}

interface PendingSerialItem {
  createTimeMs: number;
  seq: number;
  run: () => Promise<void>;
}

/**
 * Persists (bot_id, feishu_open_id, chat_id) -> thread_id mappings in SQLite and serializes
 * per-thread message processing in ascending create_time order so concurrent Feishu deliveries
 * never invoke the model concurrently or produce out-of-order replies.
 */
export class FeishuThreadSync {
  private readonly db: DatabaseSync;
  private readonly sink?: GatewayThreadSink;
  private readonly now: () => number;
  private readonly queues = new Map<string, { running: boolean; pending: PendingSerialItem[] }>();
  private seqCounter = 0;

  constructor(options: { db: DatabaseSync; sink?: GatewayThreadSink; now?: () => number }) {
    this.db = options.db;
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_thread_mappings (
        bot_id TEXT NOT NULL,
        feishu_open_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, feishu_open_id, chat_id)
      );
    `);
  }

  get hasSink(): boolean {
    return this.sink !== undefined;
  }

  getMapping(botId: string, feishuOpenId: string, chatId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT thread_id FROM feishu_thread_mappings
         WHERE bot_id = ? AND feishu_open_id = ? AND chat_id = ?`,
      )
      .get(botId, feishuOpenId, chatId) as { thread_id?: string } | undefined;
    return row?.thread_id ?? null;
  }

  resolveOrCreateThread(botId: string, feishuOpenId: string, chatId: string): string | null {
    const existing = this.getMapping(botId, feishuOpenId, chatId);
    const now = this.now();
    if (existing) {
      if (!this.sink || this.sink.hasThread(botId, existing)) {
        this.db
          .prepare(
            `UPDATE feishu_thread_mappings SET updated_at = ?
             WHERE bot_id = ? AND feishu_open_id = ? AND chat_id = ?`,
          )
          .run(now, botId, feishuOpenId, chatId);
        return existing;
      }
    }

    const title = `飞书私聊 · ${feishuOpenId.slice(-8)}`;
    const createdThreadId = this.sink
      ? this.sink.createThread(botId, title)
      : `feishu_${botId}_${feishuOpenId}_${chatId}`;
    if (!createdThreadId) return null;

    this.db
      .prepare(
        `INSERT INTO feishu_thread_mappings (bot_id, feishu_open_id, chat_id, thread_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, feishu_open_id, chat_id)
         DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
      )
      .run(botId, feishuOpenId, chatId, createdThreadId, now, now);
    return createdThreadId;
  }

  appendUserMessage(threadId: string, input: { text: string; source: "feishu" | "weixin"; senderId: string; at: number }): void {
    this.sink?.appendUserMessage(threadId, input);
  }

  appendAssistantMessage(threadId: string, input: { text: string; at: number }): void {
    this.sink?.appendAssistantMessage(threadId, input);
  }

  appendFailureMessage(threadId: string, input: { error: string; at: number }): void {
    this.sink?.appendFailureMessage(threadId, input);
  }

  setThinking(botId: string, threadId: string, thinking: boolean): void {
    this.sink?.setThinking?.(botId, threadId, thinking);
  }

  /** Runs `task` strictly serially per threadId, ordering queued items by ascending createTimeMs. */
  enqueueSerial<T>(threadId: string, createTimeMs: number, task: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(threadId);
    if (!queue) {
      queue = { running: false, pending: [] };
      this.queues.set(threadId, queue);
    }

    return new Promise<T>((resolve, reject) => {
      const item: PendingSerialItem = {
        createTimeMs,
        seq: this.seqCounter++,
        run: async () => {
          try {
            resolve(await task());
          } catch (err) {
            reject(err);
          }
        },
      };
      queue!.pending.push(item);
      queue!.pending.sort((a, b) => a.createTimeMs - b.createTimeMs || a.seq - b.seq);
      if (!queue!.running) {
        void this.drain(threadId, queue!);
      }
    });
  }

  private async drain(threadId: string, queue: { running: boolean; pending: PendingSerialItem[] }): Promise<void> {
    queue.running = true;
    try {
      while (queue.pending.length > 0) {
        const next = queue.pending.shift()!;
        await next.run();
      }
    } finally {
      queue.running = false;
      if (queue.pending.length === 0) {
        this.queues.delete(threadId);
      }
    }
  }
}

export interface StoreLikeForGateway {
  bot(id: string): { id: string } | null | undefined;
  taskByThread(botId: string, threadId: string): { threadId: string } | null | undefined;
  createTask(botId: string, title?: string, activate?: boolean): { threadId: string } | null | undefined;
  appendMessage(
    threadId: string,
    message:
      | { role: "user"; kind: "text"; text: string; source: "feishu" | "weixin"; at?: number }
      | { role: "bot"; kind: "text"; text: string; at?: number }
      | { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean }; at?: number },
  ): unknown;
  patchTask(botId: string, threadId: string, patch: { unread?: boolean }): unknown;
}

/** Adapts the harness Store so Feishu DM messages and replies appear directly in Web UI threads. */
export function createStoreThreadSink(store: StoreLikeForGateway): GatewayThreadSink {
  return {
    hasThread(botId, threadId) {
      return Boolean(store.bot(botId) && store.taskByThread(botId, threadId));
    },
    createThread(botId, title) {
      if (!store.bot(botId)) return null;
      return store.createTask(botId, title, false)?.threadId ?? null;
    },
    appendUserMessage(threadId, input) {
      store.appendMessage(threadId, {
        role: "user",
        kind: "text",
        text: input.text,
        source: input.source,
        at: input.at,
      });
    },
    appendAssistantMessage(threadId, input) {
      store.appendMessage(threadId, {
        role: "bot",
        kind: "text",
        text: input.text,
        at: input.at,
      });
    },
    appendFailureMessage(threadId, input) {
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `feishu_sync_failed: ${input.error}`, ok: false },
        at: input.at,
      });
    },
    setThinking(botId, threadId, thinking) {
      if (!thinking) {
        store.patchTask(botId, threadId, { unread: true });
      }
    },
  };
}

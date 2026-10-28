import initSqlJs, { Database } from "sql.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  thread_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: string | null; // JSON string
  created_at: string;
}

export interface ThreadInfo {
  thread_id: string;
  message_count: number;
  last_message_at: string;
  preview: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database path
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "conversations.db");

// ─────────────────────────────────────────────────────────────────────────────
// Persistence class
// ─────────────────────────────────────────────────────────────────────────────

export class ConversationStore {
  private db: Database | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the database connection and schema.
   * Safe to call multiple times - will only initialize once.
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Initialize sql.js
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    // Create schema
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_thread_id ON messages(thread_id)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_created_at ON messages(created_at)
    `);

    // Persist to disk
    this._save();
  }

  /**
   * Save database to disk.
   */
  private _save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }

  /**
   * Add a message to the conversation history.
   */
  async addMessage(
    threadId: string,
    role: "user" | "assistant" | "tool",
    content: string,
    toolCalls?: unknown[]
  ): Promise<void> {
    await this.init();
    if (!this.db) throw new Error("Database not initialized");

    const toolCallsJson = toolCalls ? JSON.stringify(toolCalls) : null;

    this.db.run(
      `INSERT INTO messages (thread_id, role, content, tool_calls) VALUES (?, ?, ?, ?)`,
      [threadId, role, content, toolCallsJson]
    );

    this._save();
  }

  /**
   * Get all messages for a thread, ordered by creation time.
   */
  async getMessages(threadId: string): Promise<StoredMessage[]> {
    await this.init();
    if (!this.db) throw new Error("Database not initialized");

    const stmt = this.db.prepare(
      `SELECT id, thread_id, role, content, tool_calls, created_at 
       FROM messages 
       WHERE thread_id = ? 
       ORDER BY created_at ASC`
    );
    stmt.bind([threadId]);

    const messages: StoredMessage[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as StoredMessage;
      messages.push(row);
    }
    stmt.free();

    return messages;
  }

  /**
   * Get recent messages for a thread (for context window).
   */
  async getRecentMessages(
    threadId: string,
    limit: number = 50
  ): Promise<StoredMessage[]> {
    await this.init();
    if (!this.db) throw new Error("Database not initialized");

    // Get the last N messages, then reverse to get chronological order
    const stmt = this.db.prepare(
      `SELECT id, thread_id, role, content, tool_calls, created_at 
       FROM messages 
       WHERE thread_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`
    );
    stmt.bind([threadId, limit]);

    const messages: StoredMessage[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as StoredMessage;
      messages.push(row);
    }
    stmt.free();

    return messages.reverse();
  }

  /**
   * List all conversation threads with metadata.
   */
  async listThreads(): Promise<ThreadInfo[]> {
    await this.init();
    if (!this.db) throw new Error("Database not initialized");

    const stmt = this.db.prepare(`
      SELECT 
        thread_id,
        COUNT(*) as message_count,
        MAX(created_at) as last_message_at,
        (SELECT content FROM messages m2 
         WHERE m2.thread_id = m1.thread_id AND m2.role = 'user' 
         ORDER BY created_at DESC LIMIT 1) as preview
      FROM messages m1
      GROUP BY thread_id
      ORDER BY last_message_at DESC
    `);

    const threads: ThreadInfo[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as ThreadInfo;
      // Truncate preview
      if (row.preview && row.preview.length > 50) {
        row.preview = row.preview.substring(0, 50) + "...";
      }
      threads.push(row);
    }
    stmt.free();

    return threads;
  }

  /**
   * Clear all messages in a thread.
   */
  async clearThread(threadId: string): Promise<number> {
    await this.init();
    if (!this.db) throw new Error("Database not initialized");

    this.db.run(`DELETE FROM messages WHERE thread_id = ?`, [threadId]);
    const changes = this.db.getRowsModified();
    this._save();

    return changes;
  }

  /**
   * Delete a thread entirely.
   */
  async deleteThread(threadId: string): Promise<number> {
    return this.clearThread(threadId);
  }

  /**
   * Get total message count across all threads.
   */
  async getStats(): Promise<{ totalMessages: number; totalThreads: number }> {
    await this.init();
    if (!this.db) throw new Error("Database not initialized");

    const msgStmt = this.db.prepare(`SELECT COUNT(*) as count FROM messages`);
    msgStmt.step();
    const totalMessages = (msgStmt.getAsObject() as { count: number }).count;
    msgStmt.free();

    const threadStmt = this.db.prepare(
      `SELECT COUNT(DISTINCT thread_id) as count FROM messages`
    );
    threadStmt.step();
    const totalThreads = (threadStmt.getAsObject() as { count: number }).count;
    threadStmt.free();

    return { totalMessages, totalThreads };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this._save();
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instance
// ─────────────────────────────────────────────────────────────────────────────

export const conversationStore = new ConversationStore();

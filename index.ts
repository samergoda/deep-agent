import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { createDeepAgent } from "deepagents";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { allTools } from "./util/tools";
import {
  API_KEY,
  MODEL_CONFIG,
  RETRY_CONFIG,
  SYSTEM_PROMPT,
  validateEnv,
} from "./util/config";
import { conversationStore, StoredMessage } from "./util/persistence";

// ─────────────────────────────────────────────────────────────────────────────
// Agent setup
// ─────────────────────────────────────────────────────────────────────────────

function buildAgent() {
  const model = new ChatOpenAI({
    model: MODEL_CONFIG.model,
    apiKey: API_KEY,
    configuration: { baseURL: MODEL_CONFIG.baseURL },
    useResponsesApi: false,
    maxTokens: MODEL_CONFIG.maxTokens,
  });

  return createDeepAgent({
    model,
    tools: allTools,
    systemPrompt: SYSTEM_PROMPT,
  });
}

type Agent = ReturnType<typeof buildAgent>;

// ─────────────────────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────────────────────

let currentThreadId = MODEL_CONFIG.threadId;

// ─────────────────────────────────────────────────────────────────────────────
// REPL loop
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  validateEnv();

  // Initialize persistence
  await conversationStore.init();
  console.log(`\n💬 Deep Agent started. Thread: ${currentThreadId}`);
  console.log("Type /help for commands, or just start chatting.\n");

  // Load and display thread stats
  const stats = await conversationStore.getStats();
  if (stats.totalMessages > 0) {
    console.log(`📊 ${stats.totalMessages} messages in ${stats.totalThreads} thread(s)\n`);
  }

  const agent = buildAgent();
  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const userInput = (await rl.question("You: ")).trim();

      if (userInput.toLowerCase() === "exit") break;
      if (!userInput) continue;

      // Handle commands
      if (userInput.startsWith("/")) {
        await handleCommand(userInput, rl);
        continue;
      }

      try {
        await runTurn(agent, userInput);
      } catch (error) {
        reportTurnError(error);
      }
    }
  } finally {
    conversationStore.close();
    rl.close();
    console.log("\n👋 Goodbye!\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleCommand(
  input: string,
  rl: readline.Interface
): Promise<void> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);
  const arg = args.join(" ");

  switch (cmd.toLowerCase()) {
    case "help":
      console.log(`
📚 Available Commands:
  /help              Show this help message
  /history           Show conversation history
  /clear             Clear current conversation
  /threads           List all conversation threads
  /switch <id>       Switch to a different thread
  /new [id]          Start a new conversation thread
  /delete <id>       Delete a conversation thread
  /stats             Show database statistics
  exit               Quit the agent
`);
      break;

    case "history": {
      const messages = await conversationStore.getMessages(currentThreadId);
      if (messages.length === 0) {
        console.log("\n📭 No messages in this thread yet.\n");
      } else {
        console.log(`\n📜 History for thread "${currentThreadId}" (${messages.length} messages):\n`);
        for (const msg of messages) {
          const timestamp = new Date(msg.created_at).toLocaleString();
          const icon = msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : "🔧";
          const preview = msg.content.length > 100 
            ? msg.content.substring(0, 100) + "..." 
            : msg.content;
          console.log(`  ${icon} [${timestamp}] ${preview}`);
        }
        console.log();
      }
      break;
    }

    case "clear": {
      const count = await conversationStore.clearThread(currentThreadId);
      console.log(`\n🗑️  Cleared ${count} messages from thread "${currentThreadId}".\n`);
      break;
    }

    case "threads": {
      const threads = await conversationStore.listThreads();
      if (threads.length === 0) {
        console.log("\n📭 No conversation threads yet.\n");
      } else {
        console.log("\n📋 Conversation Threads:\n");
        for (const t of threads) {
          const isCurrent = t.thread_id === currentThreadId ? " (current)" : "";
          const lastMsg = new Date(t.last_message_at).toLocaleString();
          console.log(`  • ${t.thread_id}${isCurrent}`);
          console.log(`    ${t.message_count} messages, last: ${lastMsg}`);
          if (t.preview) {
            console.log(`    "${t.preview}"`);
          }
          console.log();
        }
      }
      break;
    }

    case "switch": {
      if (!arg) {
        console.log("\n⚠️  Usage: /switch <thread_id>\n");
        break;
      }
      currentThreadId = arg;
      const messages = await conversationStore.getMessages(currentThreadId);
      console.log(`\n✅ Switched to thread "${currentThreadId}" (${messages.length} messages).\n`);
      break;
    }

    case "new": {
      const newId = arg || `thread-${Date.now()}`;
      currentThreadId = newId;
      console.log(`\n✅ Started new thread: "${currentThreadId}"\n`);
      break;
    }

    case "delete": {
      if (!arg) {
        console.log("\n⚠️  Usage: /delete <thread_id>\n");
        break;
      }
      if (arg === currentThreadId) {
        console.log("\n⚠️  Cannot delete the current thread. Switch to another thread first.\n");
        break;
      }
      const count = await conversationStore.deleteThread(arg);
      if (count > 0) {
        console.log(`\n🗑️  Deleted thread "${arg}" (${count} messages).\n`);
      } else {
        console.log(`\n⚠️  Thread "${arg}" not found or already empty.\n`);
      }
      break;
    }

    case "stats": {
      const stats = await conversationStore.getStats();
      console.log(`\n📊 Database Statistics:`);
      console.log(`   Total messages: ${stats.totalMessages}`);
      console.log(`   Total threads:  ${stats.totalThreads}`);
      console.log(`   Current thread: ${currentThreadId}\n`);
      break;
    }

    default:
      console.log(`\n⚠️  Unknown command: /${cmd}. Type /help for available commands.\n`);
  }
}

/** Print a user-friendly message when a conversation turn fails. */
function reportTurnError(error: unknown): void {
  if (isRetryableError(error)) {
    console.error(
      "\n❌ The model provider is temporarily unreachable " +
        "and did not recover after several retries. This is an outage on their " +
        "side, not a problem with your setup. Try again in a couple of minutes."
    );
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Something went wrong this turn: ${message}`);
  }

  console.error("You can keep chatting or type 'exit' to quit.\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation turn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a single conversation turn, streaming the agent's output
 * token-by-token and announcing any tools it uses.
 */
async function runTurn(agent: Agent, userInput: string): Promise<void> {
  // Save user message to persistence
  await conversationStore.addMessage(currentThreadId, "user", userInput);

  console.log("\n🤔 Thinking...");

  // Load recent conversation history for context
  const history = await conversationStore.getRecentMessages(currentThreadId, 20);
  const historyMessages = convertToLangChainMessages(history.slice(0, -1)); // Exclude current message

  // `streamMode: "messages"` yields [messageChunk, metadata] tuples, giving
  // token-level streaming of the model's text output. We retry on transient
  // provider/network errors (e.g. Cloudflare 5xx when the origin is briefly down).
  const stream = await withRetry(() =>
    agent.stream(
      { messages: [...historyMessages, { role: "user", content: userInput }] },
      { streamMode: "messages", configurable: { thread_id: currentThreadId } }
    )
  );

  let printedAgentHeader = false;
  const toolsAnnounced = new Set<string>();
  let fullResponse = "";

  for await (const [chunk] of stream) {
    // We only care about the model's own output (AI messages).
    if (!AIMessage.isInstance(chunk)) continue;

    // Announce tool calls as the model decides to make them.
    for (const call of chunk.tool_calls ?? []) {
      if (call.name && !toolsAnnounced.has(call.name)) {
        toolsAnnounced.add(call.name);
        console.log(`\n🔧 Using tool: ${call.name}`);
      }
    }

    // Stream text content as it arrives.
    const text = extractText(chunk.content);
    if (!text) continue;

    if (!printedAgentHeader) {
      process.stdout.write("\n🤖 Agent: ");
      printedAgentHeader = true;
    }
    process.stdout.write(text);
    fullResponse += text;
  }

  // A reasoning model can return no visible text if it exhausts its output
  // budget on reasoning tokens (finish_reason: "length", content: null).
  // Surface that clearly instead of silently returning to the prompt.
  if (!printedAgentHeader) {
    fullResponse = "(no visible content was returned — the model may have hit " +
      "its output-token limit. Try again, or raise OPENAI_MAX_TOKENS.)";
    console.log(`\n🤖 Agent: ${fullResponse}`);
  }

  // Save assistant response to persistence
  if (fullResponse) {
    await conversationStore.addMessage(
      currentThreadId,
      "assistant",
      fullResponse,
      toolsAnnounced.size > 0 ? Array.from(toolsAnnounced) : undefined
    );
  }

  console.log("\n");
}

/**
 * Convert stored messages to LangChain message format for context.
 */
function convertToLangChainMessages(messages: StoredMessage[]): BaseMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      if (m.role === "user") {
        return new HumanMessage(m.content);
      } else {
        return new AIMessage(m.content);
      }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retry an async operation with exponential backoff when it fails with a
 * transient error (network issues or 5xx responses from the model provider).
 * Non-retryable errors (e.g. bad API key, 4xx) are thrown immediately.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = RETRY_CONFIG.maxAttempts,
  baseDelayMs = RETRY_CONFIG.baseDelayMs
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.error(
        `\n⚠️  Provider temporarily unavailable (attempt ${attempt}/${maxAttempts}). ` +
          `Retrying in ${Math.round(delay / 1000)}s...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Decide whether an error is worth retrying. We retry on common transient
 * HTTP status codes (429/5xx) and low-level network errors.
 */
function isRetryableError(error: unknown): boolean {
  const retryableStatus = [429, 500, 502, 503, 504, 520, 521, 522, 523, 524];
  const retryableNetwork = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
  ];

  // Status may live on `error.status`, `error.statusCode`, or inside the message.
  const err = error as { status?: number; statusCode?: number; code?: string };
  const status = err?.status ?? err?.statusCode;
  if (typeof status === "number" && retryableStatus.includes(status)) {
    return true;
  }

  if (err?.code && retryableNetwork.includes(err.code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    retryableStatus.some((code) => message.includes(String(code))) ||
    /origin is unreachable|origin_unreachable|cloudflare|"retryable":\s*true/i.test(
      message
    )
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Content helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message content may be a plain string or an array of content blocks.
 * Pull the text out of either form.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block !== "object" || block === null) return "";

      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

main().catch((error) => {
  // Configuration errors already carry a clear, user-facing message — print it
  // on its own rather than dumping a full stack trace.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${message}`);
  process.exit(1);
});

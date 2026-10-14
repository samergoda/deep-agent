import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { allTools } from "./util/tools";
import { MODEL_CONFIG, RETRY_CONFIG, SYSTEM_PROMPT } from "./util/config";

// ─────────────────────────────────────────────────────────────────────────────
// Agent setup
// ─────────────────────────────────────────────────────────────────────────────

function buildAgent() {
  const model = new ChatOpenAI({
    model: MODEL_CONFIG.model,
    apiKey: process.env.CODECRAFT_API_KEY,
    configuration: { baseURL: MODEL_CONFIG.baseURL },
    useResponsesApi: false,
  });

  return createAgent({
    model,
    tools: allTools,
    checkpointer: new MemorySaver(),
    systemPrompt: SYSTEM_PROMPT,
  });
}

type Agent = ReturnType<typeof buildAgent>;

// ─────────────────────────────────────────────────────────────────────────────
// REPL loop
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const agent = buildAgent();
  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const userInput = (await rl.question("\nYou: ")).trim();

      if (userInput.toLowerCase() === "exit") break;
      if (!userInput) continue;

      try {
        await runTurn(agent, userInput);
      } catch (error) {
        reportTurnError(error);
      }
    }
  } finally {
    rl.close();
  }
}

/** Print a user-friendly message when a conversation turn fails. */
function reportTurnError(error: unknown): void {
  if (isRetryableError(error)) {
    console.error(
      "\n❌ The model provider (codecraftapi.com) is temporarily unreachable " +
        "and did not recover after several retries. This is an outage on their " +
        "side, not a problem with your setup. Try again in a couple of minutes."
    );
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Something went wrong this turn: ${message}`);
  }

  console.error("You can keep chatting or type 'exit' to quit.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation turn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a single conversation turn, streaming the agent's output
 * token-by-token and announcing any tools it uses.
 */
async function runTurn(agent: Agent, userInput: string): Promise<void> {
  console.log("\n🤔 Thinking...");

  // `streamMode: "messages"` yields [messageChunk, metadata] tuples, giving
  // token-level streaming of the model's text output. We retry on transient
  // provider/network errors (e.g. Cloudflare 5xx when the origin is briefly down).
  const stream = await withRetry(() =>
    agent.stream(
      { messages: [{ role: "user", content: userInput }] },
      { streamMode: "messages", configurable: { thread_id: MODEL_CONFIG.threadId } }
    )
  );

  let printedAgentHeader = false;
  const toolsAnnounced = new Set<string>();

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
  }

  console.log("\n");
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
function extractText(content: BaseMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) =>
      typeof block === "string"
        ? block
        : "text" in block && typeof block.text === "string"
        ? block.text
        : ""
    )
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

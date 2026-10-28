import * as os from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Small env helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Read an env var, falling back to a default when unset or blank. */
function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

/** Read a positive integer env var, falling back to a default when invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read a comma-separated env var into a trimmed, non-empty string array. */
function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model / provider configuration (env-driven, with sensible defaults)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The API key, preferring CODECRAFT_API_KEY and falling back to OPENAI_API_KEY.
 * May be undefined; `validateEnv()` is responsible for enforcing presence.
 */
export const API_KEY =
  process.env.CODECRAFT_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();

  export const MODEL_CONFIG = {
  model: env("OPENAI_MODEL", "deepseek-v4-flash-0731"),
  baseURL: env("OPENAI_BASE_URL", "https://codecraftapi.com/v1"),
  threadId: env("CHAT_THREAD_ID", "main-chat"),
  // Max output tokens per response. Must be large enough to cover the reasoning
  // model's hidden reasoning tokens AND the visible answer, or responses come
  // back empty (content: null). Override with OPENAI_MAX_TOKENS.
  maxTokens: envInt("OPENAI_MAX_TOKENS", 8192),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Retry policy for transient provider/network errors
// ─────────────────────────────────────────────────────────────────────────────

export const RETRY_CONFIG = {
  maxAttempts: envInt("RETRY_MAX_ATTEMPTS", 3),
  baseDelayMs: envInt("RETRY_BASE_DELAY_MS", 1500),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tool configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Default IANA timezone used by the date/time tool when none is supplied. */
export const DEFAULT_TIMEZONE = env("DEFAULT_TIMEZONE", "Asia/Amman");

/**
 * Directories the file-reader tool is allowed to access. Defaults to the
 * current user's home directory. Override with ALLOWED_READ_ROOTS (comma-separated).
 */
export const ALLOWED_READ_ROOTS = envList("ALLOWED_READ_ROOTS", [os.homedir()]);

/**
 * GitLab Personal Access Token for MR review operations.
 * Required scopes: api (for reading MRs and posting comments).
 */
export const GITLAB_TOKEN = process.env.GITLAB_TOKEN?.trim() || undefined;

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = [
  "You are a helpful AI assistant and expert code reviewer.",
  "You have access to tools for web search, math calculations, checking the current date/time, reading local files, fetching web pages, and reviewing GitLab Merge Requests.",
  "",
  "When a user provides a GitLab MR URL:",
  "1. Use the gitlab_mr_review tool to fetch the MR details and code diff",
  "2. Analyze the code changes thoroughly, looking for:",
  "   - Bugs and logical errors",
  "   - Security vulnerabilities",
  "   - Performance issues",
  "   - Code style and best practices",
  "   - Missing error handling",
  "   - Opportunities for improvement",
  "3. Provide a structured code review with specific, actionable feedback",
  "4. Use the gitlab_mr_comment tool to post your review comments directly on the MR",
  "",
  "Use your tools proactively instead of guessing at math, dates, or facts.",
  "Be concise and cite sources with URLs when using search results.",
].join(" ");

// ─────────────────────────────────────────────────────────────────────────────
// Startup validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that all required environment variables are present before the
 * agent starts. Throws an Error with a clear, actionable message listing
 * everything that's missing, so failures surface at boot rather than deep
 * inside a tool call at runtime.
 */
export function validateEnv(): void {
  const problems: string[] = [];

  if (!API_KEY) {
    problems.push(
      "• Missing model API key. Set CODECRAFT_API_KEY or OPENAI_API_KEY in your .env file."
    );
  }

  if (!process.env.TAVILY_API_KEY?.trim()) {
    problems.push(
      "• Missing TAVILY_API_KEY. The web_search tool needs it. Get a key at https://tavily.com and add it to your .env file."
    );
  }

  if (problems.length) {
    throw new Error(
      "Configuration error — the agent cannot start:\n\n" +
        problems.join("\n") +
        "\n\nSee .env for the expected variables."
    );
  }
}

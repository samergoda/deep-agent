const MODEL_CONFIG = {
  model: "deepseek-v4-flash-0731",
  baseURL: "https://codecraftapi.com/v1",
  threadId: "main-chat",
} as const;

const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1500,
} as const;

const SYSTEM_PROMPT = [
  "You are a helpful AI assistant.",
  "You have access to tools for web search, math calculations, checking the current date/time, reading local files, and fetching web pages.",
  "Use your tools proactively instead of guessing at math, dates, or facts.",
  "Be concise and cite sources with URLs when using search results.",
].join(" ");


export { MODEL_CONFIG, RETRY_CONFIG, SYSTEM_PROMPT };
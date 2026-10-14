import { tool } from "langchain";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as z from "zod";
import { tavily } from "@tavily/core";

// ─────────────────────────────────────────────────────────────────────────────
// Tavily client (initialized once, reused by webSearch)
// ─────────────────────────────────────────────────────────────────────────────

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY! });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Web Search
// ─────────────────────────────────────────────────────────────────────────────

export const webSearch = tool(
  async (input: { query: string }) => {
    const response = await tavilyClient.search(input.query);

    const summary = response.results
      .slice(0, 5)
      .map((r) => `${r.title}\n${r.url}\n${r.content}`)
      .join("\n\n");

    return summary || `No results found for "${input.query}".`;
  },
  {
    name: "web_search",
    description:
      "Search the web for up-to-date information on any topic. Use this whenever " +
      "the user asks about current events, facts, or anything that may require live information.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Calculator
// ─────────────────────────────────────────────────────────────────────────────

export const calculator = tool(
  async (input: { expression: string }) => {
    try {
      const sanitized = input.expression.replace(/[^0-9+\-*/().%\s,e]/gi, "");
      if (!sanitized.trim()) return "Invalid expression.";

      const result = Function(`"use strict"; return (${sanitized})`)();
      return `${input.expression} = ${result}`;
    } catch {
      return `Could not evaluate: "${input.expression}". Make sure it's a valid math expression.`;
    }
  },
  {
    name: "calculator",
    description:
      "Evaluate a mathematical expression. Use this for any arithmetic, " +
      "percentages, or numeric calculations instead of doing math yourself.",
    schema: z.object({
      expression: z
        .string()
        .describe("The math expression, e.g. '(15 * 3) + 7.5' or '250 / 3'"),
    }),
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Date & Time
// ─────────────────────────────────────────────────────────────────────────────

export const dateTime = tool(
  async (input: { timezone?: string }) => {
    const tz = input.timezone || "Asia/Amman";
    try {
      const now = new Date();
      const formatted = now.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: tz,
        timeZoneName: "short",
      });
      return `Current date and time (${tz}): ${formatted}`;
    } catch {
      return `Invalid timezone: "${tz}". Use IANA format like 'America/New_York' or 'Asia/Amman'.`;
    }
  },
  {
    name: "get_current_datetime",
    description:
      "Get the current date and time. Use whenever the user asks about " +
      "today's date, the current time, day of the week, or anything time-sensitive.",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone, e.g. 'America/New_York'. Defaults to Asia/Amman."),
    }),
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. File Reader
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_READ_ROOTS = ["/home/samer/"];

export const readFile = tool(
  async (input: { filePath: string; startLine?: number; endLine?: number }) => {
    const resolved = path.resolve(input.filePath);

    if (!ALLOWED_READ_ROOTS.some((root) => resolved.startsWith(root))) {
      return `Error: Cannot read files outside of: ${ALLOWED_READ_ROOTS.join(", ")}`;
    }

    try {
      const stat = await fs.stat(resolved);

      // If it's a directory, list its contents instead.
      if (stat.isDirectory()) {
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const listing = entries
          .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
          .join("\n");
        return `Directory: ${resolved}\n\n${listing}`;
      }

      if (stat.size > 500_000) {
        return `File is too large (${(stat.size / 1024).toFixed(0)} KB). Use startLine/endLine to read a portion.`;
      }

      let content = await fs.readFile(resolved, "utf8");

      // Slice to a specific line range if requested.
      if (input.startLine || input.endLine) {
        const lines = content.split("\n");
        const start = Math.max(0, (input.startLine || 1) - 1);
        const end = input.endLine || lines.length;
        content = lines.slice(start, end).join("\n");
        return `File: ${resolved} (lines ${start + 1}–${end} of ${lines.length})\n\n${content}`;
      }

      if (content.length > 15_000) {
        return (
          `File: ${resolved} (truncated to first 15,000 chars of ${content.length})\n\n` +
          `${content.slice(0, 15_000)}\n\n... [truncated]`
        );
      }

      return `File: ${resolved}\n\n${content}`;
    } catch (e) {
      return `Error reading "${resolved}": ${(e as Error).message}`;
    }
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file or list the contents of a directory. " +
      "Use when the user asks about a local file, code, document, or folder.",
    schema: z.object({
      filePath: z
        .string()
        .describe("Absolute or relative path to the file or directory"),
      startLine: z
        .number()
        .optional()
        .describe("First line to read (1-indexed). Omit to read from the beginning."),
      endLine: z
        .number()
        .optional()
        .describe("Last line to read (inclusive). Omit to read to the end."),
    }),
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Webpage Reader
// ─────────────────────────────────────────────────────────────────────────────

/** Strip HTML to plain text, removing scripts, styles, and non-content elements. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export const readUrl = tool(
  async (input: { url: string }) => {
    try {
      const response = await fetch(input.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });

      if (!response.ok) {
        return `HTTP ${response.status} ${response.statusText} when fetching ${input.url}`;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text") && !contentType.includes("json") && !contentType.includes("xml")) {
        return `Cannot read binary content (${contentType}). This tool only supports text-based pages.`;
      }

      const text = htmlToText(await response.text());

      if (!text) return `Page at ${input.url} returned no readable text content.`;

      if (text.length > 12_000) {
        return (
          `Content from ${input.url} (truncated to 12,000 chars of ${text.length}):\n\n` +
          `${text.slice(0, 12_000)}\n\n... [truncated]`
        );
      }

      return `Content from ${input.url}:\n\n${text}`;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("timeout") || msg.includes("abort")) {
        return `Timed out after 15 seconds fetching ${input.url}`;
      }
      return `Error fetching URL: ${msg}`;
    }
  },
  {
    name: "read_url",
    description:
      "Fetch and read the text content of a webpage. Use after web_search to " +
      "read a specific result page in detail, or when the user shares a URL.",
    schema: z.object({
      url: z
        .string()
        .describe("The full URL to fetch, e.g. 'https://example.com/article'"),
    }),
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: all tools as a single array for the agent
// ─────────────────────────────────────────────────────────────────────────────

export const allTools = [webSearch, calculator, dateTime, readFile, readUrl];
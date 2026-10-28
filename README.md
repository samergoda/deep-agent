# Deep Agent - AI Assistant with Tools

A conversational AI agent built with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents) (LangGraph) that can search the web, do math, read files, fetch web pages, and review GitLab merge requests.

## Features

- 🤖 **Streaming responses** — See the agent's output as it types
- 🔧 **Tool announcements** — Shows which tools are being used in real-time
- 🔄 **Automatic retries** — Handles transient API failures gracefully
- 💾 **Conversation persistence** — Chat history saved to SQLite, survives restarts
- 🔍 **Web search** — Search the internet via Tavily
- 🧮 **Calculator** — Evaluate math expressions
- 📅 **Date/Time** — Get current date/time in any timezone
- 📁 **File reader** — Read local files and directories
- 🌐 **Web fetcher** — Fetch and extract content from URLs
- 🦊 **GitLab MR review** — Fetch and review merge requests, post comments

## Prerequisites

- Node.js 22+
- npm or yarn

## Installation

```bash
# Clone/navigate to the project
cd langchain-agent

# Install dependencies
npm install
```

## Configuration

Create a `.env` file in the project root:

```bash
# Required: Model API key (one of these)
CODECRAFT_API_KEY=your_codecraft_key
# OR
OPENAI_API_KEY=your_openai_key

# Required: Tavily API key for web search
TAVILY_API_KEY=your_tavily_key  # Get one at https://tavily.com

# Optional: GitLab token for MR reviews
GITLAB_TOKEN=glpat-xxxxx  # Create at GitLab > Settings > Access Tokens

# Optional: Model configuration
OPENAI_MODEL=deepseek-v4-flash-0731
OPENAI_BASE_URL=https://codecraftapi.com/v1
OPENAI_MAX_TOKENS=8192

# Optional: Conversation persistence
CHAT_THREAD_ID=main-chat  # Unique ID for this conversation thread

# Optional: Retry configuration
RETRY_MAX_ATTEMPTS=3
RETRY_BASE_DELAY_MS=1500

# Optional: Tool configuration
DEFAULT_TIMEZONE=Asia/Amman
ALLOWED_READ_ROOTS=/home/user,/tmp  # Comma-separated paths
```

## Usage

### Start the agent

```bash
# With Cloudflare Warp (if you use it)
npm start

# Without Warp
npm run start:no-warp
```

### Chat commands

Once running, you'll see a `You:` prompt. Type your messages or use these commands:

| Command | Description |
|---------|-------------|
| `exit` | Quit the agent |
| `/history` | Show conversation history |
| `/clear` | Clear current conversation |
| `/threads` | List all saved conversation threads |
| `/switch <id>` | Switch to a different thread |
| `/new` | Start a new conversation thread |
| `/delete <id>` | Delete a conversation thread |

### Example conversations

**Web search:**
```
You: What are the latest features in Node.js 22?
🔧 Using tool: web_search
🤖 Agent: Node.js 22 introduces several exciting features...
```

**Math calculation:**
```
You: Calculate 15% of $2,340 plus tax at 7%
🔧 Using tool: calculator
🤖 Agent: 15% of $2,340 is $351. Adding 7% tax ($24.57) gives $375.57 total.
```

**File reading:**
```
You: Show me the contents of ~/projects/myapp/package.json
🔧 Using tool: read_local_file
🤖 Agent: Here's your package.json...
```

**GitLab MR review:**
```
You: Review this MR: https://gitlab.example.com/team/app/-/merge_requests/123
🔧 Using tool: gitlab_mr_review
🤖 Agent: ## Code Review: MR !123...
```

## Project Structure

```
langchain-agent/
├── index.ts          # Main agent + REPL loop + persistence
├── util/
│   ├── config.ts     # Environment & configuration
│   ├── tools.ts      # Tool definitions (search, calc, files, etc.)
│   ├── gitlab.ts     # GitLab API client
│   └── persistence.ts # SQLite conversation storage
├── data/
│   └── conversations.db  # SQLite database (auto-created)
├── package.json
├── tsconfig.json
├── .env              # Your API keys (gitignored)
├── .gitignore
└── warpssl.crt       # SSL cert for Cloudflare Warp (optional)
```

## Available Tools

| Tool | Description | Required Config |
|------|-------------|-----------------|
| `web_search` | Search the web for information | `TAVILY_API_KEY` |
| `calculator` | Evaluate math expressions | — |
| `get_current_datetime` | Get current date/time | — |
| `read_local_file` | Read files/directories | `ALLOWED_READ_ROOTS` |
| `read_url` | Fetch webpage content | — |
| `gitlab_mr_review` | Fetch MR details and diff | `GITLAB_TOKEN` |
| `gitlab_mr_comment` | Post comments on MRs | `GITLAB_TOKEN` |

## Switching Models

The agent is model-agnostic. To use a different provider:

**OpenAI:**
```bash
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

**Groq:**
```bash
OPENAI_API_KEY=gsk_xxx
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=llama-3.1-70b-versatile
```

**Anthropic (via OpenAI-compatible proxy):**
```bash
OPENAI_API_KEY=your_key
OPENAI_BASE_URL=https://your-anthropic-proxy.com/v1
OPENAI_MODEL=claude-3-sonnet
```

## Conversation Persistence

Conversations are automatically saved to `data/conversations.db` (SQLite). Features:

- **Auto-save:** Every message is persisted immediately
- **Resume:** Conversations continue from where you left off
- **Multiple threads:** Use `/switch` to manage different conversations
- **Export-friendly:** Standard SQLite format, easy to query or backup

### Database schema

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,        -- 'user' | 'assistant' | 'tool'
  content TEXT NOT NULL,
  tool_calls TEXT,           -- JSON array of tool calls (if any)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_thread_id ON messages(thread_id);
```

## Troubleshooting

### "Provider temporarily unreachable"
The model API is down. Wait a few minutes or switch to a different provider in `.env`.

### "Missing TAVILY_API_KEY"
Get a free API key at https://tavily.com and add it to your `.env` file.

### "Cannot read files outside of..."
Add the directory to `ALLOWED_READ_ROOTS` in `.env`.

### GitLab API errors
Ensure your `GITLAB_TOKEN` has `api` scope and hasn't expired.

## Development

```bash
# Type-check without running
npx tsc --noEmit

# Run directly with tsx
npx tsx --env-file=.env index.ts
```

## License

ISC

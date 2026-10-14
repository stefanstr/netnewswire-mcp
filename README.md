# NetNewsWire MCP Server (read-only fork)

Fork of [jellllly420/netnewswire-mcp](https://github.com/jellllly420/netnewswire-mcp) maintained by stefanstr for a weekly reading digest. Changes from upstream:

- **Read-only:** the `mark_articles` and `subscribe` tools and their AppleScript are removed. Nothing this server does can change read/starred state or subscriptions.
- **`sinceDays` filter** on `get_articles` (articles that arrived within the last N days), limit raised to 500.
- **300 s timeout** for `get_articles`, so sweeping a large library does not hit the 60 s default.
- **No System Events:** the "is NetNewsWire running" check uses `application "NetNewsWire" is running`, so the only Automation permission needed is control of NetNewsWire.

The only macOS permission required is Automation → NetNewsWire for the process that runs the server (Claude). No Full Disk Access.

---

An MCP server that connects Claude to [NetNewsWire](https://netnewswire.com/) via AppleScript on macOS. Browse feeds, fetch and search articles.

## Requirements

- **macOS** (uses AppleScript to communicate with NetNewsWire)
- **NetNewsWire** must be running
- **Node.js** >= 18.0.0

## Installation

### Option 1: MCP Bundle (.mcpb)

Build the bundle with `npx @anthropic-ai/mcpb pack` and double-click the resulting `.mcpb` file to install it in Claude Desktop. (Upstream releases contain the write tools; do not install those.)

### Option 2: Build from Source

```bash
git clone https://github.com/stefanstr/netnewswire-mcp.git
cd netnewswire-mcp
npm install
npm run build
```

Then add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "netnewswire": {
      "command": "node",
      "args": ["/path/to/netnewswire-mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_feeds` | List all subscribed feeds and folders, optionally filtered by account |
| `get_articles` | Fetch articles with filters: unread, starred, by feed/folder, `sinceDays`, with limit |
| `read_article` | Get full article content (HTML, text, metadata) by article ID |
| `search_articles` | Search articles by keyword across all feeds |

## Example Workflow

**Daily morning summary:**

> "Get all my unread articles from the last 7 days and give me a summary of the most interesting ones."

**Topic research:**

> "Search my feeds for articles about 'AI agents' and summarize what's been published recently."

## Development

```bash
npm run dev    # Watch mode — recompiles on changes
npm run build  # Production build
npm start      # Run the server
```

## License

MIT

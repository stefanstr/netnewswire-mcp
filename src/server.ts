import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAppleScript, isNetNewsWireRunning } from "./applescript/bridge.js";
import { scripts } from "./applescript/scripts.js";
import { parseListFeeds, parseArticles, parseFullArticle } from "./parsers.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "NetNewsWire",
    version: "0.1.4-ro.1",
  });

  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {
  // ── list_feeds ──────────────────────────────────────────────────
  server.tool(
    "list_feeds",
    "List all subscribed feeds and folders in NetNewsWire, optionally filtered by account name.",
    {
      account: z
        .string()
        .optional()
        .describe("Filter by account name (e.g. 'On My Mac', 'Feedbin')"),
    },
    async ({ account }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.listFeeds(account));
      const result = parseListFeeds(raw);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── get_articles ────────────────────────────────────────────────
  server.tool(
    "get_articles",
    "Fetch articles from NetNewsWire. Returns article metadata (title, URL, date, read/starred status). Use read_article to get full content.",
    {
      feedUrl: z
        .string()
        .optional()
        .describe("Filter by feed URL"),
      folderName: z
        .string()
        .optional()
        .describe("Filter by folder name"),
      unreadOnly: z
        .boolean()
        .default(false)
        .describe("Only return unread articles"),
      starredOnly: z
        .boolean()
        .default(false)
        .describe("Only return starred articles"),
      sinceDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Only return articles that arrived in NetNewsWire within the last N days"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of articles to return (default 50, max 500)"),
    },
    async ({ feedUrl, folderName, unreadOnly, starredOnly, sinceDays, limit }) => {
      await ensureRunning();
      // Sweeping every feed of a large library can exceed the bridge's 60s
      // default; scripts.getArticles wraps its work in `with timeout of 300
      // seconds`, so the subprocess budget must match (fork change).
      const raw = await runAppleScript(
        scripts.getArticles({ feedUrl, folderName, unreadOnly, starredOnly, sinceDays, limit }),
        { timeoutMs: 300_000 }
      );
      const articles = parseArticles(raw);
      return {
        content: [
          {
            type: "text",
            text: articles.length
              ? JSON.stringify(articles, null, 2)
              : "No articles found matching the criteria.",
          },
        ],
      };
    }
  );

  // ── read_article ────────────────────────────────────────────────
  server.tool(
    "read_article",
    "Get the full content of a specific article by its ID. Returns title, HTML content, plain text, summary, and metadata.",
    {
      articleId: z.string().describe("The article ID to read"),
    },
    async ({ articleId }) => {
      await ensureRunning();
      // Cold-cache or missing-ID lookups walk every feed in every
      // account, which can exceed the bridge's default 60s subprocess
      // timeout on large libraries. The AppleScript itself caps
      // individual Apple Events at 300s via `with timeout`, so the
      // subprocess budget must match — otherwise Node kills osascript
      // before the AppleScript-side -1712 re-raise can take effect.
      const raw = await runAppleScript(
        scripts.readArticle(articleId),
        { timeoutMs: 300_000 }
      );
      if (raw.startsWith("ERROR:")) {
        return {
          content: [{ type: "text", text: raw.substring(6) }],
          isError: true,
        };
      }
      const article = parseFullArticle(raw);
      return { content: [{ type: "text", text: JSON.stringify(article, null, 2) }] };
    }
  );

  // ── search_articles ─────────────────────────────────────────────
  server.tool(
    "search_articles",
    "Search articles by keyword in titles and body content across all feeds.",
    {
      query: z.string().describe("Search keyword or phrase"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum results to return (default 20)"),
    },
    async ({ query, limit }) => {
      await ensureRunning();
      // Search across large libraries can take longer than the default 60s
      // subprocess timeout, even with the whose-clause filter pushdown. The
      // AppleScript itself wraps the iteration in `with timeout of 300 seconds`
      // and re-raises -1712 as an actionable error; the subprocess cap must
      // be ≥ that, otherwise Node kills osascript before the AppleScript-side
      // error handling can fire and the caller sees the same misleading
      // "Command failed: osascript -e <script>" shape as the original bug (#6).
      const raw = await runAppleScript(
        scripts.searchArticles(query, limit),
        { timeoutMs: 300_000 }
      );
      const articles = parseArticles(raw);
      return {
        content: [
          {
            type: "text",
            text: articles.length
              ? JSON.stringify(articles, null, 2)
              : `No articles found matching "${query}".`,
          },
        ],
      };
    }
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

async function ensureRunning(): Promise<void> {
  const running = await isNetNewsWireRunning();
  if (!running) {
    throw new Error(
      "NetNewsWire is not running. Please launch NetNewsWire and try again."
    );
  }
}


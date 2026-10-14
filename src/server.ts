import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAppleScript, isNetNewsWireRunning, launchNetNewsWire } from "./applescript/bridge.js";
import { scripts } from "./applescript/scripts.js";
import { parseListFeeds, parseArticles, parseFullArticle, cleanSummary } from "./parsers.js";
import type { ArticleSummary } from "./parsers.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "NetNewsWire",
    version: "0.1.4-ro.3",
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
      const raw = await runAppleScript(scripts.listFeeds(account), { timeoutMs: 300_000 });
      const result = parseListFeeds(raw);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  // ── get_articles ────────────────────────────────────────────────
  server.tool(
    "get_articles",
    "Fetch articles from NetNewsWire, newest first. Returns metadata (title, URL, feed URL, ISO dates, read/starred status) and a short plain-text summary. " +
      "If `truncated` is true, more articles matched than `limit`; narrow by folder, feed or sinceDays. Use read_article with id and feedUrl for full content.",
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
        .describe("Only return articles published within the last N days (arrival date when a feed gives no publication date)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of articles to return (default 50, max 500)"),
      summaryChars: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .default(400)
        .describe("Length of the plain-text summary per article (default 400, 0 to omit)"),
    },
    async ({ feedUrl, folderName, unreadOnly, starredOnly, sinceDays, limit, summaryChars }) => {
      await ensureRunning();
      // Sweeping every feed of a large library can exceed the bridge's 60s
      // default; scripts.getArticles wraps its work in `with timeout of 300
      // seconds`, so the subprocess budget must match. One extra record is
      // requested so truncation can be reported instead of hidden.
      const now = new Date();
      const raw = await runAppleScript(
        scripts.getArticles({ feedUrl, folderName, unreadOnly, starredOnly, sinceDays, limit: limit + 1, withText: summaryChars > 0 }),
        { timeoutMs: 300_000 }
      );
      const parsed = parseArticles(raw, now);
      const truncated = parsed.length > limit;
      const articles = sortNewestFirst(parsed.slice(0, limit)).map((a) => ({
        ...a,
        summary: cleanSummary(a.summary, summaryChars),
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: articles.length, truncated, articles }),
          },
        ],
      };
    }
  );

  // ── read_article ────────────────────────────────────────────────
  server.tool(
    "read_article",
    "Get the full content of a specific article by its ID. Returns title, HTML content, plain text, summary, and metadata. " +
      "Article IDs are only unique within a feed, so pass the feedUrl returned by get_articles.",
    {
      articleId: z.string().describe("The article ID to read"),
      feedUrl: z
        .string()
        .optional()
        .describe("Feed URL of the article (from get_articles); strongly recommended"),
    },
    async ({ articleId, feedUrl }) => {
      await ensureRunning();
      // Cold-cache or missing-ID lookups walk every feed in every
      // account, which can exceed the bridge's default 60s subprocess
      // timeout on large libraries. The AppleScript itself caps
      // individual Apple Events at 300s via `with timeout`, so the
      // subprocess budget must match — otherwise Node kills osascript
      // before the AppleScript-side -1712 re-raise can take effect.
      const raw = await runAppleScript(
        scripts.readArticle(articleId, feedUrl),
        { timeoutMs: 300_000 }
      );
      if (raw.startsWith("ERROR:")) {
        return {
          content: [{ type: "text", text: raw.substring(6) }],
          isError: true,
        };
      }
      const article = parseFullArticle(raw);
      return { content: [{ type: "text", text: JSON.stringify(article) }] };
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
      const articles = sortNewestFirst(parseArticles(raw));
      return {
        content: [
          {
            type: "text",
            text: articles.length
              ? JSON.stringify(articles)
              : `No articles found matching "${query}".`,
          },
        ],
      };
    }
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Make sure NetNewsWire runs. Fork change: launch it if needed instead of
 * failing, so unattended (scheduled) runs work when the app was quit.
 * Launching does not change any data in NetNewsWire.
 */
async function ensureRunning(): Promise<void> {
  if (await isNetNewsWireRunning()) return;
  await launchNetNewsWire();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isNetNewsWireRunning()) {
      // Give the app a moment to load its accounts before scripting it.
      await sleep(5000);
      return;
    }
  }
  throw new Error(
    "NetNewsWire is not running and could not be launched. Please open it and try again."
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sort by publication date, newest first; undated articles go last. */
export function sortNewestFirst(articles: ArticleSummary[]): ArticleSummary[] {
  const key = (a: ArticleSummary) => a.publishedAt || a.arrivedAt || "";
  return [...articles].sort((x, y) => key(y).localeCompare(key(x)));
}

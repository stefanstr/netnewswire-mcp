import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Cross-layer regression tests for the server.ts ↔ scripts.ts seam.
 *
 * Background: the bridge in src/applescript/bridge.ts has a 60s
 * subprocess timeout by default. When a `scripts.X(...)` template
 * wraps its work in `with timeout of 300 seconds` (so individual
 * Apple Events can survive long sweeps on large libraries), the
 * corresponding `runAppleScript(...)` callsite in server.ts MUST
 * also pass `{ timeoutMs: 300_000 }` — otherwise Node kills the
 * osascript subprocess at the 60s default, well before the
 * AppleScript-side timeout can take effect. That defeats the
 * cold-cache fix on exactly the libraries it targets.
 *
 * Copilot caught this regression on PR #7 iteration 2 (searchArticles)
 * and again on PR #8 iteration 1 (readArticle). Locking it down here
 * so the same class of mistake can't recur silently on the next tool.
 *
 * These tests do source-level pattern matching rather than mocking the
 * server, which is brittle to indentation but matches the philosophy of
 * the existing scripts.test.ts (string-shape checks).
 */
describe("server.ts ↔ scripts.ts timeout alignment", () => {
  const serverSrc = readFileSync(
    fileURLToPath(new URL("./server.ts", import.meta.url)),
    "utf8"
  );

  /** Slice from `"toolName"` through the next `\n  );` (closes server.tool). */
  function callsiteFor(toolName: string): string {
    const idx = serverSrc.indexOf(`"${toolName}"`);
    if (idx < 0) throw new Error(`tool ${toolName} not found in server.ts`);
    const end = serverSrc.indexOf("\n  );", idx);
    return serverSrc.slice(idx, end > 0 ? end : undefined);
  }

  it("read_article calls runAppleScript with timeoutMs: 300_000", () => {
    // scripts.readArticle wraps in `with timeout of 300 seconds`, so
    // the callsite must override the bridge's 60s subprocess default
    // to match. Without this override, large-library miss-path
    // lookups (cold cache, deleted-since-listing) get killed at 60s
    // before the AppleScript-side timeout / -1712 re-raise kicks in.
    const block = callsiteFor("read_article");
    expect(block).toContain("scripts.readArticle(");
    expect(block).toContain("timeoutMs: 300_000");
  });

  it("get_articles calls runAppleScript with timeoutMs: 300_000", () => {
    const block = callsiteFor("get_articles");
    expect(block).toContain("scripts.getArticles(");
    expect(block).toContain("timeoutMs: 300_000");
  });
});

describe("read-only fork", () => {
  const serverSrc = readFileSync(
    fileURLToPath(new URL("./server.ts", import.meta.url)),
    "utf8"
  );
  const scriptsSrc = readFileSync(
    fileURLToPath(new URL("./applescript/scripts.ts", import.meta.url)),
    "utf8"
  );
  const bridgeSrc = readFileSync(
    fileURLToPath(new URL("./applescript/bridge.ts", import.meta.url)),
    "utf8"
  );

  it("registers no write tools", () => {
    expect(serverSrc).not.toContain('"mark_articles"');
    expect(serverSrc).not.toContain('"subscribe"');
  });

  it("generates no AppleScript that writes to NetNewsWire", () => {
    expect(scriptsSrc).not.toMatch(/set (read|starred) of/);
    expect(scriptsSrc).not.toContain("make new feed");
  });

  it("does not need System Events", () => {
    expect(bridgeSrc).not.toContain('tell application "System Events"');
  });
});

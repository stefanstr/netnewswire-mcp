import { describe, it, expect } from "vitest";
import { scripts } from "./scripts.js";

/**
 * Tests for the AppleScript template generators.
 *
 * These tests assert the *intent* of the generated AppleScript via
 * substring/pattern matches, not snapshots — exact whitespace can change
 * without anything being broken, but the structural pieces (filter
 * pushdown, early exit, timeout wrapping, escaping, error sentinels)
 * are the things the runtime actually depends on.
 */

describe("scripts.listFeeds", () => {
  it("scopes to a specific account when a name is given", () => {
    const s = scripts.listFeeds("On My Mac");
    expect(s).toContain('whose name is "On My Mac"');
  });

  it("enumerates every account when no filter is given", () => {
    const s = scripts.listFeeds();
    expect(s).toContain("repeat with acct in every account");
    expect(s).not.toContain("whose name is");
  });

  it("escapes account names containing quotes", () => {
    const s = scripts.listFeeds('Acct "X"');
    expect(s).toContain('whose name is "Acct \\"X\\""');
  });

  it("emits ACCOUNT/FOLDER/FEED record prefixes the parser expects", () => {
    const s = scripts.listFeeds();
    expect(s).toContain('"ACCOUNT:"');
    expect(s).toContain('"FOLDER:"');
    expect(s).toContain('"FEED:"');
  });
});

describe("scripts.getArticles", () => {
  it("filters at the NetNewsWire level when unreadOnly is set", () => {
    const s = scripts.getArticles({ unreadOnly: true });
    expect(s).toContain("set artRef to a reference to (every article of nthFeed whose read is false)");
  });

  it("filters at the NetNewsWire level when starredOnly is set", () => {
    const s = scripts.getArticles({ starredOnly: true });
    expect(s).toContain("set artRef to a reference to (every article of nthFeed whose starred is true)");
  });

  it("scopes by feed URL when feedUrl is given", () => {
    const s = scripts.getArticles({ feedUrl: "https://example.com/feed.xml" });
    expect(s).toContain('if url of nthFeed is "https://example.com/feed.xml"');
  });

  it("scopes by folder name when folderName is given", () => {
    const s = scripts.getArticles({ folderName: "Tech" });
    expect(s).toContain('if name of fld is "Tech"');
  });

  it("respects an explicit limit", () => {
    const s = scripts.getArticles({ limit: 25 });
    expect(s).toContain("set maxArticles to 25");
  });

  it("defaults to a limit of 50 when none is given", () => {
    const s = scripts.getArticles({});
    expect(s).toContain("set maxArticles to 50");
  });

  it("escapes feed URLs containing quotes", () => {
    const s = scripts.getArticles({ feedUrl: 'https://e.com/"x"' });
    expect(s).toContain('if url of nthFeed is "https://e.com/\\"x\\""');
  });

  it("emits the ARTICLE: record prefix the parser expects", () => {
    const s = scripts.getArticles({});
    expect(s).toContain('"ARTICLE:"');
  });

  it("wraps the sweep in a 300 second AppleScript timeout", () => {
    const s = scripts.getArticles({ unreadOnly: true });
    expect(s).toContain("with timeout of 300 seconds");
    expect(s).toContain("end timeout");
  });

  it("filters by arrived date when sinceDays is set", () => {
    const s = scripts.getArticles({ unreadOnly: true, sinceDays: 7 });
    expect(s).toContain("set cutoffDate to nowDate - (7 * days)");
    expect(s).toContain("set d to item i of lPub");
    expect(s).toContain("if d is missing value then set d to item i of lArr");
    expect(s).toContain("if d < cutoffDate then set keep to false");
  });

  it("emits no date filter when sinceDays is absent", () => {
    const s = scripts.getArticles({ unreadOnly: true });
    expect(s).not.toContain("cutoffDate");
  });

  it("balances if/end if when sinceDays is set", () => {
    const s = scripts.getArticles({ sinceDays: 3 });
    const ifs = (s.match(/^\s*if .* then$/gm) ?? []).length;
    const endIfs = (s.match(/^\s*end if$/gm) ?? []).length;
    expect(ifs).toBe(endIfs);
  });
});

describe("scripts.readArticle", () => {
  // ── Performance-critical structure (pre-emptive fix mirroring #2 / #4) ─
  //
  // The pre-fix shape was:
  //   repeat with acct in every account
  //     repeat with nthFeed in allFeeds of acct
  //       repeat with a in every article of nthFeed
  //         if id of a is "..." then ...
  //
  // That's one Apple Event per article per property access — vulnerable
  // to the same -1712 / 60s Node-subprocess timeout that markArticles
  // and searchArticles hit on large libraries with a cold cache. The fix
  // mirrors markArticles: push the predicate into NNW via `whose`, wrap
  // in `with timeout`, and add per-feed `on error` handling that
  // re-raises systemic codes.
  describe("performance structure", () => {
    it("uses a `whose` clause to push the ID filter into NetNewsWire", () => {
      const s = scripts.readArticle("abc-123");
      // The filter must run inside NNW (one Apple Event per feed), not
      // out here (one Apple Event per article).
      expect(s).toContain('every article of nthFeed whose (id is "abc-123")');
    });

    it("does not fall back to per-article `id of a is` iteration", () => {
      const s = scripts.readArticle("abc");
      // Pre-fix anti-pattern: `repeat with a in every article ... if id of a is`.
      // Reintroducing it would put us back at the 60s subprocess timeout
      // on cold-cache reads.
      expect(s).not.toMatch(/repeat with a in every article[\s\S]*if id of a is/);
    });

    it("does NOT use the `is in {...}` membership operator", () => {
      // NetNewsWire's scripting layer silently returns no matches for
      // `whose id is in {...}`. Locked down so a future refactor doesn't
      // reach for it as the "obvious" replacement.
      const s = scripts.readArticle("abc");
      expect(s).not.toMatch(/whose [^()]*is in \{/);
    });

    it("wraps the work in `with timeout of 300 seconds`", () => {
      // The default Apple Event timeout is 60s. On a cold cache reading
      // back the full body of an article from a large library, that's
      // not enough — bump to 5 min to match markArticles.
      const s = scripts.readArticle("abc");
      expect(s).toContain("with timeout of 300 seconds");
      expect(s).toContain("end timeout");
    });

    it("returns early as soon as the matching article is found", () => {
      // readArticle's early-exit shape is `return` from inside the feed
      // loop the moment a non-empty match comes back — the equivalent of
      // markArticles' `exit repeat`. Without this, even a successful
      // match would keep scanning every remaining feed before answering.
      const s = scripts.readArticle("abc");
      // The return must be assembled from a matched article (TITLE:...)
      // and live inside the loop body, before the not-found sentinel.
      const notFoundIdx = s.indexOf('"ERROR:Article not found"');
      const titleReturnIdx = s.indexOf('return "TITLE:"');
      expect(titleReturnIdx).toBeGreaterThan(0);
      expect(notFoundIdx).toBeGreaterThan(titleReturnIdx);
    });

    it("preserves the ERROR:Article not found sentinel for misses", () => {
      // server.ts surfaces this string to the caller verbatim; if the
      // fix accidentally drops it, every miss becomes an empty success.
      const s = scripts.readArticle("missing");
      expect(s).toContain('return "ERROR:Article not found"');
    });
  });

  // ── Error handling: systemic vs. per-feed transient ──────────────────
  describe("error handling", () => {
    it("attaches an `on error` handler so errors aren't blindly swallowed", () => {
      const s = scripts.readArticle("abc");
      expect(s).toContain("on error errMsg number errNum");
    });

    it("rethrows the five systemic Apple Event error codes", () => {
      const s = scripts.readArticle("abc");
      // Same five codes as markArticles — the failures the user actually
      // needs to see, not silently turn into "Article not found".
      //   -128 user cancelled
      //   -600 application not running
      //   -609 connection invalid
      //   -1712 Apple Event timed out (despite the outer 300s wrapper)
      //   -1743 not authorized (automation permission denied)
      for (const code of [-128, -600, -609, -1712, -1743]) {
        expect(s).toContain(`errNum is ${code}`);
      }
    });

    it("re-raises by preserving the original error number", () => {
      const s = scripts.readArticle("abc");
      expect(s).toContain("error errMsg number errNum");
    });
  });

  // ── ID escaping (injection / quoting safety) ─────────────────────────
  describe("id escaping", () => {
    it("escapes double quotes in the article ID inside the whose clause", () => {
      const s = scripts.readArticle('a"b');
      expect(s).toContain('whose (id is "a\\"b")');
    });

    it("escapes backslashes in the article ID", () => {
      // JS literal "a\\b" is the 3-char string a\b. After escape it's a\\b
      // in AppleScript source, which is `"a\\\\b"` in JS source.
      const s = scripts.readArticle("a\\b");
      expect(s).toContain('whose (id is "a\\\\b")');
    });

    it("preserves realistic URL-style IDs without mangling", () => {
      const id = "http://example.com/feed/article-1.html";
      const s = scripts.readArticle(id);
      expect(s).toContain(`whose (id is "${id}")`);
    });
  });

  // ── Output contract for parseFullArticle ─────────────────────────────
  it("emits all field prefixes the parseFullArticle parser expects", () => {
    const s = scripts.readArticle("x");
    for (const prefix of ["TITLE:", "URL:", "FEEDURL:", "FEED:", "PUBMIN:", "READ:", "STARRED:", "AUTHORS:", "SUMMARY:", "HTML:", "TEXT:"]) {
      expect(s).toContain(`"${prefix}"`);
    }
  });
});

describe("scripts.searchArticles", () => {
  it("embeds the search query as searchTerm", () => {
    const s = scripts.searchArticles("AI agents");
    expect(s).toContain('set searchTerm to "AI agents"');
  });

  it("checks all four article body properties for the search term inside a `whose` clause", () => {
    // NetNewsWire's article class exposes four text properties that can carry
    // searchable body content. Different feed formats populate different ones:
    //
    //   - title     : always populated (RSS and Atom both have <title>)
    //   - html      : RSS feeds put body bytes here via contentHTML (mapped
    //                 from <description> or <content:encoded>); Atom feeds
    //                 may also populate this from <content type="html">
    //   - contents  : Atom feeds populate via contentText; RSS feeds always
    //                 have nil here (RSSParser hardcodes contentText: nil in
    //                 RSSItem.toParsedItem — see NetNewsWire commit
    //                 c9d54214e346fc6cfa33724fdbfea3f96ac4e8d5)
    //   - summary   : Atom feeds populate from <summary>; RSS feeds have
    //                 nil here (RSS has no <summary> element)
    //
    // The whose-clause must check ALL FOUR so neither RSS nor Atom feeds
    // silently miss matches. Pre-fix (iteration 1-3) only checked title +
    // contents, which meant RSS feeds were effectively title-only because
    // contents was always nil. Iteration 4 (driven by source-walking NNW's
    // RSSParser + SearchTable.swift + Article+Scriptability.swift, plus
    // empirical confirmation that html contains 8KB-200KB of body bytes for
    // the same feeds where contents was empty) fixes that.
    const s = scripts.searchArticles("foo");
    // Predicate must live inside a whose-clause (so NNW filters natively),
    // not in repeat-body conditionals (which would be one Apple Event per
    // article — the original #6 IPC-blowup shape).
    expect(s).toMatch(/every article of nthFeed whose \(/);
    // All four properties present, order-insensitive.
    expect(s).toContain("title contains searchTerm");
    expect(s).toContain("html contains searchTerm");
    expect(s).toContain("contents contains searchTerm");
    expect(s).toContain("summary contains searchTerm");
  });

  it("checks `html contains searchTerm` to cover RSS feeds whose bodies land in contentHTML", () => {
    // Regression test pinning the specific RSS-feed fix from iteration 4.
    // RSSParser hardcodes ParsedItem(contentText: nil, ...) in
    // RSSItem.toParsedItem (NetNewsWire @ c9d54214e346fc6cfa33724fdbfea3f96ac4e8d5)
    // for every RSS-format feed, so `contents` is unconditionally empty for RSS.
    // The body bytes land in contentHTML, exposed via the `html` scripting
    // property (Mac/Scripting/Article+Scriptability.swift). Without this
    // predicate in the whose-clause, RSS feeds match by title only — which
    // was the title-primary limitation iteration 3 documented and iteration 4
    // resolves. A regression that drops `html contains` here will re-break
    // body-text search for every RSS-format feed in a NetNewsWire library.
    const s = scripts.searchArticles("foo");
    expect(s).toContain("html contains searchTerm");
  });

  it("respects an explicit limit", () => {
    const s = scripts.searchArticles("foo", 10);
    expect(s).toContain("set maxResults to 10");
  });

  it("defaults to a limit of 20 when none is given", () => {
    const s = scripts.searchArticles("foo");
    expect(s).toContain("set maxResults to 20");
  });

  it("escapes quotes in the search query", () => {
    const s = scripts.searchArticles('say "hi"');
    expect(s).toContain('set searchTerm to "say \\"hi\\""');
  });

  it("early-exits the article loop once the limit is reached", () => {
    const s = scripts.searchArticles("foo", 5);
    expect(s).toContain("if matchCount ≥ maxResults then exit repeat");
  });

  // ── Performance-critical structure (regression tests for #6) ─────────
  describe("performance structure", () => {
    it("wraps the work in `with timeout of 300 seconds`", () => {
      // Without an outer timeout the bridge's 60s subprocess cap fires before
      // osascript can return, surfacing as `Command failed: osascript -e <script>`
      // with no AppleScript error code — the exact failure mode reported in #6.
      const s = scripts.searchArticles("foo");
      expect(s).toContain("with timeout of 300 seconds");
      expect(s).toContain("end timeout");
    });

    it("uses a `whose` clause to push the substring filter into NetNewsWire", () => {
      // Without this, every article in the library is materialised across the
      // IPC boundary just to compare two strings in AppleScript. The whose
      // clause lets NNW filter natively, so we only iterate matches.
      const s = scripts.searchArticles("foo");
      expect(s).toMatch(/every article of nthFeed whose \(/);
    });

    it("does not fetch `contents of a` for every article", () => {
      // The pre-fix shape was `repeat with a in every article ... set aText to contents of a`,
      // which made *every* article incur a full-body database read across IPC even
      // when the article was about to be discarded. After the fix, `contents of a`
      // should only appear inside the post-filter match-formatting block — not as
      // an unconditional per-iteration read.
      const s = scripts.searchArticles("foo");
      expect(s).not.toMatch(/repeat with a in every article[\s\S]*set aText to contents of a/);
    });

    it("attaches an `on error` handler so per-feed errors aren't blindly swallowed", () => {
      const s = scripts.searchArticles("foo");
      expect(s).toContain("on error errMsg number errNum");
    });

    it("rethrows the five systemic Apple Event error codes", () => {
      const s = scripts.searchArticles("foo");
      // Same five codes as markArticles: -128 user cancelled, -600 not running,
      // -609 connection invalid, -1712 Apple Event timeout, -1743 not authorized.
      for (const code of [-128, -600, -609, -1712, -1743]) {
        expect(s).toContain(`errNum is ${code}`);
      }
    });

    it("has early-exit checks at the account and feed loop levels", () => {
      const s = scripts.searchArticles("foo", 5);
      const matches = s.match(/if matchCount ≥ maxResults then exit repeat/g);
      // One before iterating feeds within an account, one before iterating
      // matches within a feed — without these, a single-match search still
      // walks the entire library.
      expect(matches?.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("wire format (fork)", () => {
  const all = [
    scripts.listFeeds(),
    scripts.getArticles({ unreadOnly: true, sinceDays: 7 }),
    scripts.readArticle("x"),
    scripts.searchArticles("q"),
  ];

  it("defines ASCII 31/30 separators in every script", () => {
    for (const s of all) {
      expect(s).toContain("set US to (character id 31)");
      expect(s).toContain("set RS to (character id 30)");
    }
  });

  it("no longer uses the pipe character as a field separator", () => {
    for (const s of all) {
      expect(s).not.toContain('& "|" &');
    }
  });

  it("never converts dates with `as string` (locale-dependent)", () => {
    for (const s of all) {
      expect(s).not.toMatch(/(published|arrived) date of a as string/);
      expect(s).not.toMatch(/(published|arrived) date of a\) as string/);
    }
  });

  it("sends dates as whole minutes before now", () => {
    expect(scripts.getArticles({})).toContain("return ((nowDate - d) div 60) as string");
    expect(scripts.getArticles({})).toContain("my mins(item i of lPub, nowDate)");
    expect(scripts.searchArticles("q")).toContain("((nowDate - (published date of a)) div 60) as string");
  });

  it("includes the feed URL in article records", () => {
    expect(scripts.getArticles({})).toContain("set feedUrl to url of nthFeed");
    expect(scripts.searchArticles("q")).toContain("set aFeedUrl to url of feed of a");
  });

  it("caps summaries inside AppleScript", () => {
    expect(scripts.getArticles({})).toContain("text 1 thru 2000 of aSum");
  });

  it("balances try/end try and if/end if in every script", () => {
    for (const s of all) {
      const tries = (s.match(/^\s*try$/gm) ?? []).length;
      const endTries = (s.match(/^\s*end try$/gm) ?? []).length;
      expect(tries).toBe(endTries);
      const ifs = (s.match(/^\s*if .* then$/gm) ?? []).length;
      const endIfs = (s.match(/^\s*end if$/gm) ?? []).length;
      expect(ifs).toBe(endIfs);
    }
  });
});

describe("scripts.readArticle feed scoping (fork)", () => {
  it("scopes the lookup to one feed when feedUrl is given", () => {
    const s = scripts.readArticle("1", "https://a.example/feed");
    expect(s).toContain('if url of nthFeed is "https://a.example/feed" then');
  });

  it("searches every feed when feedUrl is absent", () => {
    expect(scripts.readArticle("1")).not.toContain("if url of nthFeed is");
  });
});

describe("scripts.getArticles bulk fetch (fork)", () => {
  it("fetches each property once per feed instead of once per article", () => {
    const s = scripts.getArticles({ unreadOnly: true, sinceDays: 7 });
    for (const prop of ["id", "title", "url", "published date", "arrived date", "read", "starred"]) {
      expect(s).toContain(`of artRef`);
      expect(s).toMatch(new RegExp(`set l\\w+ to ${prop} of artRef`));
    }
    expect(s).not.toContain("repeat with a in");
  });

  it("falls back from summary to html to raw contents", () => {
    const s = scripts.getArticles({});
    expect(s).toContain("set lHtml to html of artRef");
    expect(s).toContain("set lText to «class Cnts» of artRef");
    const iHtml = s.indexOf('if aSum is "" then set aSum to my txt(item i of lHtml)');
    const iText = s.indexOf('if aSum is "" and lText is not {} then set aSum to my txt(item i of lText)');
    expect(iHtml).toBeGreaterThan(0);
    expect(iText).toBeGreaterThan(iHtml);
  });

  it("never uses the ambiguous `contents of` outside a whose clause", () => {
    for (const s of [scripts.getArticles({}), scripts.readArticle("x"), scripts.searchArticles("q"), scripts.listFeeds()]) {
      expect(s).not.toMatch(/\bcontents of\b/);
    }
  });

  it("reads plain text in read_article through the raw property code", () => {
    expect(scripts.readArticle("x")).toContain("set aText to «class Cnts» of a");
  });

  it("skips summary and contents entirely when withText is false", () => {
    const s = scripts.getArticles({ withText: false });
    expect(s).not.toContain("summary of artRef");
    expect(s).not.toContain("contents of artRef");
  });

  it("filters by publication date with arrival date as fallback", () => {
    const s = scripts.getArticles({ sinceDays: 7 });
    expect(s.indexOf("set d to item i of lPub")).toBeLessThan(s.indexOf("set d to item i of lArr"));
  });

  it("defines the txt/mins handlers outside the tell block", () => {
    const s = scripts.getArticles({});
    expect(s.indexOf("on txt(v)")).toBeLessThan(s.indexOf('tell application "NetNewsWire"'));
    expect(s.indexOf("end mins")).toBeLessThan(s.indexOf('tell application "NetNewsWire"'));
  });

  it("guards against lists that no longer line up", () => {
    expect(scripts.getArticles({})).toContain("then set n to 0");
  });
});

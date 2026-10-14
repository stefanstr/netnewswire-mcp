import { describe, it, expect } from "vitest";
import {
  parseListFeeds,
  parseArticles,
  parseFullArticle,
  minutesAgoToIso,
  cleanSummary,
} from "./parsers.js";
import { sortNewestFirst } from "./server.js";

const US = "\u001f";
const RS = "\u001e";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const rec = (...fields: string[]) => fields.join(US) + RS;

describe("parseListFeeds", () => {
  it("parses accounts with top-level feeds", () => {
    const raw =
      rec("ACCOUNT:iCloud", "true") +
      rec("FEED:My Blog", "https://example.com/feed.xml", "https://example.com") +
      rec("FEED:Other Feed", "https://other.com/rss", "");

    expect(parseListFeeds(raw)).toEqual([
      {
        name: "iCloud",
        active: true,
        feeds: [
          { name: "My Blog", url: "https://example.com/feed.xml", homePageUrl: "https://example.com" },
          { name: "Other Feed", url: "https://other.com/rss", homePageUrl: "" },
        ],
        folders: [],
      },
    ]);
  });

  it("parses folders with nested feeds", () => {
    const raw =
      rec("ACCOUNT:On My Mac", "true") +
      rec("FOLDER:Tech") +
      rec("FEED:Hacker News", "https://hn.com/rss", "https://hn.com") +
      rec("FOLDER:News") +
      rec("FEED:BBC", "https://bbc.com/rss", "https://bbc.com");

    const result = parseListFeeds(raw);
    expect(result[0]!.feeds).toEqual([]);
    expect(result[0]!.folders.map((f) => f.name)).toEqual(["Tech", "News"]);
    expect(result[0]!.folders[1]!.feeds[0]!.name).toBe("BBC");
  });

  it("parses multiple accounts", () => {
    const raw =
      rec("ACCOUNT:iCloud", "true") +
      rec("FEED:Feed A", "https://a.com/rss", "") +
      rec("ACCOUNT:Feedbin", "false") +
      rec("FEED:Feed B", "https://b.com/rss", "");

    const result = parseListFeeds(raw);
    expect(result.map((a) => [a.name, a.active])).toEqual([
      ["iCloud", true],
      ["Feedbin", false],
    ]);
  });

  it("keeps feed names containing a pipe intact", () => {
    const raw = rec("ACCOUNT:iCloud", "true") + rec("FEED:Blog | Site", "https://a.com/rss", "");
    expect(parseListFeeds(raw)[0]!.feeds[0]!.name).toBe("Blog | Site");
  });

  it("handles empty input", () => {
    expect(parseListFeeds("")).toEqual([]);
  });
});

describe("parseArticles", () => {
  it("parses all fields and converts minutes-ago to ISO dates", () => {
    const raw = rec(
      "ARTICLE:id-1",
      "My Article",
      "https://example.com/post",
      "https://example.com/feed",
      "My Blog",
      "false",
      "true",
      "60",
      "30",
      "A summary"
    );

    expect(parseArticles(raw, NOW)).toEqual([
      {
        id: "id-1",
        title: "My Article",
        url: "https://example.com/post",
        feedUrl: "https://example.com/feed",
        feed: "My Blog",
        read: false,
        starred: true,
        publishedAt: "2026-10-14T11:00:00.000Z",
        arrivedAt: "2026-10-14T11:30:00.000Z",
        summary: "A summary",
      },
    ]);
  });

  it("regression: a title containing '|' does not shift the fields", () => {
    const raw = rec("ARTICLE:1", "Post title | Blog name", "https://e.com/p", "https://e.com/f", "Blog", "true", "false", "5", "5", "");
    const [a] = parseArticles(raw, NOW);
    expect(a!.title).toBe("Post title | Blog name");
    expect(a!.url).toBe("https://e.com/p");
    expect(a!.read).toBe(true);
  });

  it("regression: a summary containing newlines is kept whole", () => {
    const raw = rec("ARTICLE:1", "T", "u", "f", "F", "false", "false", "1", "1", "line one\nline two\nARTICLE:fake");
    const result = parseArticles(raw, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toBe("line one\nline two\nARTICLE:fake");
  });

  it("parses several records and skips junk", () => {
    const raw =
      "junk" + RS +
      rec("ARTICLE:a", "A", "u", "f", "F", "false", "false", "1", "1", "") +
      rec("ARTICLE:b", "B", "u", "f", "F", "false", "false", "2", "2", "");
    expect(parseArticles(raw, NOW).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("leaves dates empty when AppleScript could not read them", () => {
    const raw = rec("ARTICLE:a", "A", "u", "f", "F", "false", "false", "", "", "");
    const [a] = parseArticles(raw, NOW);
    expect(a!.publishedAt).toBe("");
    expect(a!.arrivedAt).toBe("");
    expect(a!.summary).toBeUndefined();
  });

  it("handles empty input", () => {
    expect(parseArticles("")).toEqual([]);
  });
});

describe("parseFullArticle", () => {
  const raw = [
    "TITLE:My Article",
    "URL:https://example.com/post",
    "FEEDURL:https://example.com/feed",
    "FEED:My Blog",
    "PUBMIN:1440",
    "READ:false",
    "STARRED:true",
    "AUTHORS:John, Jane, ",
    "SUMMARY:A brief summary",
    "HTML:<div>\n  <p>URL: not a field</p>\n  <p>TEXT: also not a field</p>\n</div>",
    "TEXT:Line 1\nLine 2",
  ].join(US);

  it("parses every field", () => {
    expect(parseFullArticle(raw, NOW)).toEqual({
      title: "My Article",
      url: "https://example.com/post",
      feedUrl: "https://example.com/feed",
      feed: "My Blog",
      publishedAt: "2026-10-13T12:00:00.000Z",
      read: false,
      starred: true,
      authors: "John, Jane",
      summary: "A brief summary",
      html: "<div>\n  <p>URL: not a field</p>\n  <p>TEXT: also not a field</p>\n</div>",
      text: "Line 1\nLine 2",
    });
  });

  it("regression: HTML lines that look like field prefixes stay in the HTML", () => {
    const a = parseFullArticle(raw, NOW);
    expect(a.url).toBe("https://example.com/post");
    expect(a.html).toContain("URL: not a field");
  });

  it("handles empty input", () => {
    const a = parseFullArticle("");
    expect(a.title).toBe("");
    expect(a.publishedAt).toBe("");
  });
});

describe("minutesAgoToIso", () => {
  it("converts integers and rejects anything else", () => {
    expect(minutesAgoToIso("0", NOW)).toBe(NOW.toISOString());
    expect(minutesAgoToIso("-5", NOW)).toBe("2026-10-14T12:05:00.000Z");
    expect(minutesAgoToIso("1,5", NOW)).toBe("");
    expect(minutesAgoToIso("środa, 14 października 2026", NOW)).toBe("");
    expect(minutesAgoToIso(undefined, NOW)).toBe("");
  });
});

describe("cleanSummary", () => {
  it("strips tags, decodes entities and collapses whitespace", () => {
    expect(cleanSummary("<p>Fish &amp; chips</p>\n<script>x()</script><b>now</b>&#33;", 100)).toBe(
      "Fish & chips now !"
    );
  });

  it("cuts at a word boundary and marks the cut", () => {
    expect(cleanSummary("alpha beta gamma delta", 13)).toBe("alpha beta…");
  });

  it("returns undefined for empty input or zero length", () => {
    expect(cleanSummary("", 100)).toBeUndefined();
    expect(cleanSummary("<p> </p>", 100)).toBeUndefined();
    expect(cleanSummary("text", 0)).toBeUndefined();
  });
});

describe("sortNewestFirst", () => {
  it("orders by publication date and puts undated articles last", () => {
    const base = { title: "", url: "", feedUrl: "", feed: "", read: false, starred: false };
    const sorted = sortNewestFirst([
      { ...base, id: "old", publishedAt: "2026-10-01T00:00:00.000Z", arrivedAt: "" },
      { ...base, id: "none", publishedAt: "", arrivedAt: "" },
      { ...base, id: "new", publishedAt: "2026-10-13T00:00:00.000Z", arrivedAt: "" },
      { ...base, id: "arrived", publishedAt: "", arrivedAt: "2026-10-10T00:00:00.000Z" },
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["new", "arrived", "old", "none"]);
  });
});

describe("htmlToText and feedDisplayName (fork)", () => {
  it("keeps paragraph breaks when converting HTML", async () => {
    const { htmlToText } = await import("./parsers.js");
    expect(htmlToText("<p>One&nbsp;two</p><p>Three<br>four</p>")).toBe("One two\nThree\nfour");
  });

  it("derives text from HTML when read_article has no plain text", () => {
    const raw = ["TITLE:T", "HTML:<p>Hello</p><p>World</p>", "TEXT:"].join(US);
    expect(parseFullArticle(raw, NOW).text).toBe("Hello\nWorld");
  });

  it("uses the feed host when NetNewsWire returns an empty feed name", () => {
    const raw = rec("ARTICLE:1", "T", "u", "https://www.simonwillison.net/atom/everything/", "", "false", "false", "1", "1", "");
    expect(parseArticles(raw, NOW)[0]!.feed).toBe("simonwillison.net");
  });
});

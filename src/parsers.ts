/**
 * Parsers for AppleScript output from NetNewsWire.
 *
 * Fork change: records are separated by ASCII 30 and fields by ASCII 31
 * (see scripts.ts), so titles and summaries may contain "|" and newlines.
 * Dates arrive as whole minutes before the moment the script ran and are
 * converted to ISO 8601 here.
 */

import { FIELD_SEP, RECORD_SEP } from "./applescript/scripts.js";

export interface FeedInfo {
  name: string;
  url: string;
  homePageUrl: string;
}

export interface FolderInfo {
  name: string;
  feeds: FeedInfo[];
}

export interface AccountInfo {
  name: string;
  active: boolean;
  feeds: FeedInfo[];
  folders: FolderInfo[];
}

function records(raw: string): string[] {
  return raw.split(RECORD_SEP).map((r) => r.replace(/^\s+/, "")).filter((r) => r.length > 0);
}

/** Convert "minutes before now" to ISO 8601; empty or invalid gives "". */
export function minutesAgoToIso(value: string | undefined, now: Date = new Date()): string {
  if (value === undefined) return "";
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return "";
  return new Date(now.getTime() - Number(trimmed) * 60_000).toISOString();
}

export function parseListFeeds(raw: string): AccountInfo[] {
  const accounts: AccountInfo[] = [];
  let currentAccount: AccountInfo | null = null;
  let currentFolder: FolderInfo | null = null;

  for (const rec of records(raw)) {
    if (rec.startsWith("ACCOUNT:")) {
      const parts = rec.substring(8).split(FIELD_SEP);
      currentAccount = {
        name: parts[0] ?? "",
        active: parts[1] === "true",
        feeds: [],
        folders: [],
      };
      currentFolder = null;
      accounts.push(currentAccount);
    } else if (rec.startsWith("FOLDER:") && currentAccount) {
      currentFolder = { name: rec.substring(7), feeds: [] };
      currentAccount.folders.push(currentFolder);
    } else if (rec.startsWith("FEED:") && currentAccount) {
      const parts = rec.substring(5).split(FIELD_SEP);
      const feed: FeedInfo = {
        name: parts[0] ?? "",
        url: parts[1] ?? "",
        homePageUrl: parts[2] ?? "",
      };
      if (currentFolder) {
        currentFolder.feeds.push(feed);
      } else {
        currentAccount.feeds.push(feed);
      }
    }
  }
  return accounts;
}

export interface ArticleSummary {
  id: string;
  title: string;
  url: string;
  feedUrl: string;
  feed: string;
  read: boolean;
  starred: boolean;
  publishedAt: string;
  arrivedAt: string;
  summary?: string;
}

export function parseArticles(raw: string, now: Date = new Date()): ArticleSummary[] {
  const articles: ArticleSummary[] = [];
  for (const rec of records(raw)) {
    if (!rec.startsWith("ARTICLE:")) continue;
    const p = rec.substring(8).split(FIELD_SEP);
    articles.push({
      id: p[0] ?? "",
      title: p[1] ?? "",
      url: p[2] ?? "",
      feedUrl: p[3] ?? "",
      feed: feedDisplayName(p[4] ?? "", p[3] ?? ""),
      read: p[5] === "true",
      starred: p[6] === "true",
      publishedAt: minutesAgoToIso(p[7], now),
      arrivedAt: minutesAgoToIso(p[8], now),
      // The summary is the last field; rejoin in case it contained a stray
      // separator character.
      summary: p.slice(9).join(FIELD_SEP) || undefined,
    });
  }
  return articles;
}

export interface FullArticle {
  title: string;
  url: string;
  feedUrl: string;
  feed: string;
  publishedAt: string;
  read: boolean;
  starred: boolean;
  authors: string;
  summary: string;
  html: string;
  text: string;
}

const FULL_KEYS = [
  "TITLE",
  "URL",
  "FEEDURL",
  "FEED",
  "PUBMIN",
  "READ",
  "STARRED",
  "AUTHORS",
  "SUMMARY",
  "HTML",
  "TEXT",
] as const;

export function parseFullArticle(raw: string, now: Date = new Date()): FullArticle {
  const fields: Record<string, string> = {};
  let currentKey = "";
  for (const part of raw.split(FIELD_SEP)) {
    const colon = part.indexOf(":");
    const key = colon > 0 ? part.substring(0, colon) : "";
    if ((FULL_KEYS as readonly string[]).includes(key) && !(key in fields)) {
      currentKey = key;
      fields[key] = part.substring(colon + 1);
    } else if (currentKey) {
      // A stray separator inside a value: keep the text with the field.
      fields[currentKey] += FIELD_SEP + part;
    }
  }

  return {
    title: fields["TITLE"] ?? "",
    url: fields["URL"] ?? "",
    feedUrl: fields["FEEDURL"] ?? "",
    feed: feedDisplayName(fields["FEED"] ?? "", fields["FEEDURL"] ?? ""),
    publishedAt: minutesAgoToIso(fields["PUBMIN"], now),
    read: fields["READ"] === "true",
    starred: fields["STARRED"] === "true",
    authors: (fields["AUTHORS"] ?? "").replace(/,\s*$/, ""),
    summary: fields["SUMMARY"] ?? "",
    html: fields["HTML"] ?? "",
    // Derived from the HTML: NNW's `contents` property cannot be read
    // reliably from AppleScript (see scripts.ts).
    text: fields["TEXT"] || htmlToText(fields["HTML"]),
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Convert HTML to plain text, keeping paragraph breaks. */
export function htmlToText(input: string | undefined): string {
  if (!input) return "";
  return input
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip HTML, decode common entities, collapse whitespace, cap length. */
export function cleanSummary(input: string | undefined, maxChars: number): string | undefined {
  if (!input || maxChars <= 0) return undefined;
  let text = htmlToText(input).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
  }
  return text;
}

/** Feed name to show; NetNewsWire returns "" when no custom name is set. */
export function feedDisplayName(name: string, feedUrl: string): string {
  if (name) return name;
  try {
    return new URL(feedUrl).hostname.replace(/^www\./, "");
  } catch {
    return feedUrl;
  }
}

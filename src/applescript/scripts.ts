/**
 * AppleScript templates for communicating with NetNewsWire.
 *
 * Property names match NNW's sdef (scripting dictionary):
 * - Application: current article, selected articles, accounts, feeds
 * - Account: name, id, active, allFeeds, folders, opml representation
 * - Feed: url, name, homepage url, icon url, favicon url, articles, authors
 * - Folder: name, id, feeds, articles
 * - Article: id, title, url, external url, contents, html, summary,
 *            published date, arrived date, read, starred, feed
 * - Author: name, url, avatar url, email address
 *
 * Wire format (fork change): fields are separated by ASCII 31 (unit
 * separator) and records by ASCII 30 (record separator). Feed titles and
 * summaries routinely contain "|" and newlines, which broke the original
 * pipe/linefeed format. Dates are sent as whole minutes before "now",
 * because date subtraction is locale-independent while `date as string`
 * follows the macOS language setting.
 *
 * This fork is read-only: no template here sets `read`/`starred` or
 * creates feeds.
 */

/** Field separator, ASCII 31. Must match parsers.ts. */
export const FIELD_SEP = "\u001f";
/** Record separator, ASCII 30. Must match parsers.ts. */
export const RECORD_SEP = "\u001e";

/** AppleScript prologue defining the separators and the reference time. */
const PROLOGUE = `
  set US to (character id 31)
  set RS to (character id 30)
  set nowDate to (current date)`;

/** Longest summary passed back from AppleScript; the server trims further. */
const SUMMARY_CAP = 2000;

/**
 * Top-level AppleScript handlers (must sit outside the `tell` block and are
 * called with `my`). Bulk property lists contain `missing value` where a
 * feed omits a field.
 */
const HANDLERS = `
on txt(v)
  if v is missing value then return ""
  return v as text
end txt

on mins(d, nowDate)
  if d is missing value then return ""
  return ((nowDate - d) div 60) as string
end mins
`;

/** Codes that must not be swallowed by per-feed `try` blocks. */
const RERAISE = `
        on error errMsg number errNum
          -- Re-raise systemic errors so the caller sees an actionable
          -- failure. Per-feed transient errors are swallowed so one bad
          -- feed does not abort the whole sweep. Codes:
          --   -128  user cancelled
          --   -600  application not running
          --   -609  connection invalid
          --   -1712 Apple Event timed out (despite the outer 300s wrapper)
          --   -1743 not authorized (automation permission denied)
          if errNum is -128 or errNum is -600 or errNum is -609 or errNum is -1712 or errNum is -1743 then
            error errMsg number errNum
          end if`;

/**
 * AppleScript that appends one ARTICLE record for article `a` to `output`.
 * Field order must match parseArticles: id, title, url, feedUrl, feed,
 * read, starred, publishedMinutesAgo, arrivedMinutesAgo, summary.
 */
function articleRecord(withSummary: boolean): string {
  const summary = withSummary
    ? `
          set aSummary to ""
          try
            set aSummary to summary of a
            if (length of aSummary) > ${SUMMARY_CAP} then set aSummary to text 1 thru ${SUMMARY_CAP} of aSummary
          end try`
    : `
          set aSummary to ""`;
  return `
          set aId to id of a
          set aTitle to ""
          try
            set aTitle to title of a
          end try
          set aUrl to ""
          try
            set aUrl to url of a
          end try
          set aPub to ""
          try
            set aPub to ((nowDate - (published date of a)) div 60) as string
          end try
          set aArr to ""
          try
            set aArr to ((nowDate - (arrived date of a)) div 60) as string
          end try${summary}
          set aFeedName to name of feed of a
          set aFeedUrl to url of feed of a
          set output to output & "ARTICLE:" & aId & US & aTitle & US & aUrl & US & aFeedUrl & US & aFeedName & US & (read of a) & US & (starred of a) & US & aPub & US & aArr & US & aSummary & RS`;
}

export const scripts = {
  /**
   * List all accounts with their feeds and folders.
   * Uses `every feed of acct` for top-level feeds (not in any folder).
   */
  listFeeds: (accountName?: string) => {
    const accountFilter = accountName
      ? `whose name is "${escapeForAppleScript(accountName)}"`
      : "";
    return `
tell application "NetNewsWire"${PROLOGUE}
  with timeout of 300 seconds
  set output to ""
  repeat with acct in every account ${accountFilter}
    set output to output & "ACCOUNT:" & (name of acct) & US & (active of acct) & RS

    -- Top-level feeds (not in folders)
    repeat with f in every feed of acct
      set fHome to ""
      try
        set fHome to homepage url of f
      end try
      set output to output & "FEED:" & (name of f) & US & (url of f) & US & fHome & RS
    end repeat

    -- Folders and their feeds
    repeat with fld in every folder of acct
      set output to output & "FOLDER:" & (name of fld) & RS
      repeat with f in every feed of fld
        set fHome to ""
        try
          set fHome to homepage url of f
        end try
        set output to output & "FEED:" & (name of f) & US & (url of f) & US & fHome & RS
      end repeat
    end repeat
  end repeat
  return output
  end timeout
end tell`;
  },

  /**
   * Get articles filtered by various criteria.
   *
   * Performance (fork rewrite): the original issued roughly ten Apple
   * Events per article, which on a library with ~1600 unread articles
   * took well over a minute. This version asks NetNewsWire for each
   * property of all matching articles of a feed at once (one Apple Event
   * per property per feed) and builds the records locally.
   *
   * read/starred filters are pushed into NetNewsWire with a `whose`
   * clause. The `sinceDays` filter is applied locally on the publication
   * date, falling back to the arrival date when a feed gives none. The
   * arrival date alone is unreliable: a re-sync stamps old articles with
   * a fresh arrival date.
   *
   * When `withText` is set, the summary is taken from `summary`, or from
   * `contents` when the feed provides no summary (common in NNW).
   *
   * `limit` is the number of records the script may emit. The server asks
   * for one more than it returns, so it can report truncation.
   */
  getArticles: (opts: {
    feedUrl?: string;
    folderName?: string;
    unreadOnly?: boolean;
    starredOnly?: boolean;
    sinceDays?: number;
    limit?: number;
    withText?: boolean;
  }) => {
    const limit = opts.limit ?? 50;
    const sinceDays =
      opts.sinceDays && opts.sinceDays > 0 ? Math.floor(opts.sinceDays) : 0;
    const withText = opts.withText ?? true;

    const whereClause = opts.unreadOnly
      ? " whose read is false"
      : opts.starredOnly
        ? " whose starred is true"
        : "";

    const textFetch = withText
      ? `
            set lSum to summary of artRef
            set lCont to contents of artRef`
      : "";

    const textValue = withText
      ? `
                set aSum to my txt(item i of lSum)
                if aSum is "" then set aSum to my txt(item i of lCont)
                if (length of aSum) > ${SUMMARY_CAP} then set aSum to text 1 thru ${SUMMARY_CAP} of aSum`
      : `
                set aSum to ""`;

    const dateCheck = sinceDays
      ? `
              set d to item i of lPub
              if d is missing value then set d to item i of lArr
              if d is not missing value then
                if d < cutoffDate then set keep to false
              end if`
      : "";

    const articleBlock = `
        try
          set artRef to a reference to (every article of nthFeed${whereClause})
          set n to count of artRef
          if n > 0 then
            set feedName to name of nthFeed
            set feedUrl to url of nthFeed
            set lIds to id of artRef
            set lTitles to title of artRef
            set lUrls to url of artRef
            set lPub to published date of artRef
            set lArr to arrived date of artRef
            set lRead to read of artRef
            set lStar to starred of artRef${textFetch}
            -- The lists come from separate Apple Events; skip the feed if
            -- it changed in between and the lists no longer line up.
            set n to count of lIds
            if (count of lTitles) is not n or (count of lPub) is not n or (count of lStar) is not n then set n to 0
            repeat with i from 1 to n
              if articleCount ≥ maxArticles then exit repeat
              set keep to true${dateCheck}
              if keep then${textValue}
                set output to output & "ARTICLE:" & my txt(item i of lIds) & US & my txt(item i of lTitles) & US & my txt(item i of lUrls) & US & feedUrl & US & feedName & US & (item i of lRead) & US & (item i of lStar) & US & my mins(item i of lPub, nowDate) & US & my mins(item i of lArr, nowDate) & US & aSum & RS
                set articleCount to articleCount + 1
              end if
            end repeat
          end if${RERAISE}
        end try`;

    let feedIteration: string;
    if (opts.feedUrl) {
      feedIteration = `
  repeat with acct in every account
    repeat with nthFeed in allFeeds of acct
      if articleCount ≥ maxArticles then exit repeat
      if url of nthFeed is "${escapeForAppleScript(opts.feedUrl)}" then
${articleBlock}
      end if
    end repeat
  end repeat`;
    } else if (opts.folderName) {
      feedIteration = `
  repeat with acct in every account
    repeat with fld in every folder of acct
      if articleCount ≥ maxArticles then exit repeat
      if name of fld is "${escapeForAppleScript(opts.folderName)}" then
        repeat with nthFeed in every feed of fld
          if articleCount ≥ maxArticles then exit repeat
${articleBlock}
        end repeat
      end if
    end repeat
  end repeat`;
    } else {
      feedIteration = `
  repeat with acct in every account
    if articleCount ≥ maxArticles then exit repeat
    repeat with nthFeed in allFeeds of acct
      if articleCount ≥ maxArticles then exit repeat
${articleBlock}
    end repeat
  end repeat`;
    }

    const cutoffLine = sinceDays
      ? `
  set cutoffDate to nowDate - (${sinceDays} * days)`
      : "";

    return `${HANDLERS}
tell application "NetNewsWire"${PROLOGUE}
  with timeout of 300 seconds
  set output to ""
  set articleCount to 0
  set maxArticles to ${limit}${cutoffLine}
${feedIteration}
  return output
  end timeout
end tell`;
  },

  /**
   * Read the full content of a specific article by ID.
   *
   * Article IDs come from the feed and are only unique within a feed, so
   * passing `feedUrl` (returned by get_articles) scopes the lookup and
   * avoids returning another feed's article with the same ID.
   *
   * Uses a `whose` clause so NetNewsWire performs the ID filter natively,
   * returns as soon as a match is found, and wraps the work in `with
   * timeout of 300 seconds` for large libraries.
   */
  readArticle: (articleId: string, feedUrl?: string) => {
    const feedGuardOpen = feedUrl
      ? `
      if url of nthFeed is "${escapeForAppleScript(feedUrl)}" then`
      : "";
    const feedGuardClose = feedUrl
      ? `
      end if`
      : "";
    return `
tell application "NetNewsWire"${PROLOGUE}
  with timeout of 300 seconds
    repeat with acct in every account
      repeat with nthFeed in allFeeds of acct${feedGuardOpen}
        try
          set matched to (every article of nthFeed whose (id is "${escapeForAppleScript(articleId)}"))
          if (count of matched) > 0 then
            set a to item 1 of matched
            set aTitle to ""
            try
              set aTitle to title of a
            end try
            set aUrl to ""
            try
              set aUrl to url of a
            end try
            set aHtml to ""
            try
              set aHtml to html of a
            end try
            set aText to ""
            try
              set aText to contents of a
            end try
            set aSummary to ""
            try
              set aSummary to summary of a
            end try
            set aPub to ""
            try
              set aPub to ((nowDate - (published date of a)) div 60) as string
            end try
            set aAuthors to ""
            try
              repeat with auth in every author of a
                set aAuthors to aAuthors & name of auth & ", "
              end repeat
            end try
            return "TITLE:" & aTitle & US & "URL:" & aUrl & US & "FEEDURL:" & (url of nthFeed) & US & "FEED:" & (name of nthFeed) & US & "PUBMIN:" & aPub & US & "READ:" & (read of a) & US & "STARRED:" & (starred of a) & US & "AUTHORS:" & aAuthors & US & "SUMMARY:" & aSummary & US & "HTML:" & aHtml & US & "TEXT:" & aText
          end if${RERAISE}
        end try${feedGuardClose}
      end repeat
    end repeat
  end timeout
  return "ERROR:Article not found"
end tell`;
  },

  /**
   * Search articles by keyword in title and body content.
   *
   * The search is pushed into NetNewsWire with a `whose` clause over the
   * four text properties and wrapped in `with timeout of 300 seconds`.
   */
  searchArticles: (query: string, limit?: number) => {
    const maxResults = limit ?? 20;
    return `
tell application "NetNewsWire"${PROLOGUE}
  set output to ""
  set matchCount to 0
  set maxResults to ${maxResults}
  set searchTerm to "${escapeForAppleScript(query)}"
  with timeout of 300 seconds
    repeat with acct in every account
      if matchCount ≥ maxResults then exit repeat
      repeat with nthFeed in allFeeds of acct
        if matchCount ≥ maxResults then exit repeat
        try
          set matched to (every article of nthFeed whose (title contains searchTerm or html contains searchTerm or contents contains searchTerm or summary contains searchTerm))
          repeat with a in matched
            if matchCount ≥ maxResults then exit repeat${articleRecord(false)}
            set matchCount to matchCount + 1
          end repeat${RERAISE}
        end try
      end repeat
    end repeat
  end timeout
  return output
end tell`;
  },
} as const;

function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

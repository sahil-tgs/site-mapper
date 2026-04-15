export interface CrawlEvent {
  type: "page" | "error" | "done" | "status";
  url?: string;
  links?: string[];
  depth?: number;
  title?: string;
  error?: string;
  totalCrawled?: number;
  totalQueued?: number;
  message?: string;
}

interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  timeout: number;
}

const DEFAULT_OPTIONS: CrawlOptions = {
  maxPages: 300,
  maxDepth: 8,
  concurrency: 6,
  timeout: 12000,
};

// File extensions to skip
const SKIP_EXTENSIONS = new Set([
  ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".webm", ".ogg",
  ".css", ".js", ".map", ".woff", ".woff2", ".ttf", ".eot",
  ".xml", ".rss", ".atom", ".json", ".csv", ".xls", ".xlsx", ".doc", ".docx",
  ".exe", ".dmg", ".apk", ".deb", ".rpm",
]);

// URL patterns that indicate auth / login / dead ends
const AUTH_PATTERNS = [
  /\/login/i, /\/signin/i, /\/sign-in/i, /\/sign_in/i,
  /\/signup/i, /\/sign-up/i, /\/sign_up/i, /\/register/i,
  /\/auth\//i, /\/oauth/i, /\/sso/i,
  /\/forgot[-_]?password/i, /\/reset[-_]?password/i,
  /\/logout/i, /\/signout/i,
  /\/account\/create/i,
];

// Patterns to skip entirely
const SKIP_URL_PATTERNS = [
  /^mailto:/i, /^tel:/i, /^javascript:/i, /^data:/i, /^#/,
  /^ftp:/i, /^file:/i,
  /\?(.*&)?utm_/i,                // tracking params
  /\/wp-admin/i, /\/wp-login/i,   // WordPress admin
  /\/admin\//i,                     // admin panels
  /\/api\//i, /\/graphql/i,        // API endpoints
  /\.php\?/i,                       // PHP query pages (often infinite)
  /\/tag\//i, /\/tags\//i,         // tag pages (can be huge)
  /\/page\/\d+/i,                   // pagination (infinite)
  /[?&](page|p|offset)=\d/i,       // pagination params
  /\/feed\/?$/i,                    // RSS feeds
  /\/print\//i,                     // print versions
  /\/share\?/i, /\/share\//i,      // share links
];

// Page content that indicates auth walls
const AUTH_BODY_PATTERNS = [
  /type=["']password["']/i,
  /name=["']password["']/i,
  /<form[^>]*login/i,
  /<form[^>]*signin/i,
  /sign\s*in\s*to\s*(your|continue)/i,
  /log\s*in\s*to\s*(your|continue)/i,
  /create\s*(an?\s*)?account/i,
];

function normalizeUrl(urlStr: string, base: string): string | null {
  try {
    const url = new URL(urlStr, base);
    // Remove hash, trailing slash, common tracking params
    url.hash = "";
    url.searchParams.delete("utm_source");
    url.searchParams.delete("utm_medium");
    url.searchParams.delete("utm_campaign");
    url.searchParams.delete("utm_content");
    url.searchParams.delete("utm_term");
    url.searchParams.delete("ref");
    url.searchParams.delete("fbclid");
    url.searchParams.delete("gclid");

    let path = url.pathname.replace(/\/+$/, "") || "/";
    url.pathname = path;

    return url.toString();
  } catch {
    return null;
  }
}

function shouldSkipUrl(url: string, origin: string): string | null {
  // Skip non-http
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

  try {
    const parsed = new URL(url);

    // Same origin only
    if (parsed.origin !== origin) return null;

    // Skip file extensions
    const path = parsed.pathname.toLowerCase();
    for (const ext of SKIP_EXTENSIONS) {
      if (path.endsWith(ext)) return null;
    }

    // Skip URL patterns
    for (const pattern of SKIP_URL_PATTERNS) {
      if (pattern.test(url)) return null;
    }

    return url;
  } catch {
    return null;
  }
}

function isAuthUrl(url: string): boolean {
  for (const pattern of AUTH_PATTERNS) {
    if (pattern.test(url)) return true;
  }
  return false;
}

function isAuthPage(html: string): boolean {
  let matches = 0;
  for (const pattern of AUTH_BODY_PATTERNS) {
    if (pattern.test(html)) matches++;
  }
  // Need at least 2 signals to flag as auth page
  return matches >= 2;
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  // Match href attributes in anchor tags
  const hrefRegex = /<a[^>]+href=["']([^"'#][^"']*)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1].trim();
    if (!href) continue;
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) links.push(normalized);
  }
  return [...new Set(links)];
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim().slice(0, 100);
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) return h1Match[1].trim().slice(0, 100);
  return "";
}

export async function* crawl(
  startUrl: string,
  opts: Partial<CrawlOptions> = {}
): AsyncGenerator<CrawlEvent> {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  let origin: string;
  try {
    origin = new URL(startUrl).origin;
  } catch {
    yield { type: "error", error: "Invalid URL" };
    return;
  }

  const visited = new Set<string>();
  const queued = new Set<string>();
  let crawledCount = 0;

  // BFS queue: [url, depth, parentUrl]
  type QueueItem = { url: string; depth: number; parent: string | null };
  const queue: QueueItem[] = [];

  // Normalize and enqueue start URL
  const startNormalized = normalizeUrl(startUrl, startUrl);
  if (!startNormalized) {
    yield { type: "error", error: "Invalid start URL" };
    return;
  }

  queue.push({ url: startNormalized, depth: 0, parent: null });
  queued.add(startNormalized);

  yield {
    type: "status",
    message: `Starting crawl from ${origin}`,
    totalCrawled: 0,
    totalQueued: 1,
  };

  // Process queue with concurrency
  async function fetchPage(
    item: QueueItem
  ): Promise<CrawlEvent & { newLinks?: QueueItem[] }> {
    const { url, depth } = item;

    // Auth URL check
    if (isAuthUrl(url)) {
      return {
        type: "page",
        url,
        links: [],
        depth,
        title: "[Auth Page - Skipped]",
        newLinks: [],
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeout);

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; SiteMapper/1.0; +https://sitemapper.dev)",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timer);

      // Check for auth responses
      if (response.status === 401 || response.status === 403) {
        return {
          type: "page",
          url,
          links: [],
          depth,
          title: `[${response.status} Blocked]`,
          newLinks: [],
        };
      }

      if (!response.ok) {
        return {
          type: "error",
          url,
          error: `HTTP ${response.status}`,
          depth,
          newLinks: [],
        };
      }

      // Only process HTML
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        return {
          type: "page",
          url,
          links: [],
          depth,
          title: "[Non-HTML]",
          newLinks: [],
        };
      }

      const html = await response.text();

      // Auth page content check
      if (isAuthPage(html)) {
        return {
          type: "page",
          url,
          links: [],
          depth,
          title: extractTitle(html) || "[Auth Page - Skipped]",
          newLinks: [],
        };
      }

      const title = extractTitle(html);
      const rawLinks = extractLinks(html, url);

      // Filter links: same origin, not visited, not queued
      const validLinks: string[] = [];
      const newItems: QueueItem[] = [];

      for (const link of rawLinks) {
        const clean = shouldSkipUrl(link, origin);
        if (!clean) continue;
        if (visited.has(clean) || queued.has(clean)) {
          // Still record the link for graph edges, but don't re-crawl
          validLinks.push(clean);
          continue;
        }

        validLinks.push(clean);

        // Only queue if within depth limit and page limit
        if (depth + 1 <= options.maxDepth && queued.size < options.maxPages * 2) {
          newItems.push({ url: clean, depth: depth + 1, parent: url });
          queued.add(clean);
        }
      }

      return {
        type: "page",
        url,
        links: validLinks,
        depth,
        title,
        newLinks: newItems,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Fetch failed";
      return {
        type: "error",
        url,
        error: msg.includes("abort") ? "Timeout" : msg,
        depth,
        newLinks: [],
      };
    }
  }

  // Process with controlled concurrency
  while (queue.length > 0 && crawledCount < options.maxPages) {
    // Take a batch from the queue
    const batchSize = Math.min(
      options.concurrency,
      queue.length,
      options.maxPages - crawledCount
    );
    const batch = queue.splice(0, batchSize);

    // Mark all as visited
    for (const item of batch) {
      visited.add(item.url);
    }

    // Fetch all concurrently
    const results = await Promise.all(batch.map(fetchPage));

    for (const result of results) {
      crawledCount++;

      // Add new links to queue
      if (result.newLinks) {
        for (const newItem of result.newLinks) {
          if (!visited.has(newItem.url)) {
            queue.push(newItem);
          }
        }
      }

      // Yield the event (without internal newLinks field)
      const { newLinks: _, ...event } = result;
      yield {
        ...event,
        totalCrawled: crawledCount,
        totalQueued: queue.length + crawledCount,
      };
    }

    yield {
      type: "status",
      message: `Crawled ${crawledCount} pages, ${queue.length} in queue...`,
      totalCrawled: crawledCount,
      totalQueued: queue.length + crawledCount,
    };
  }

  yield {
    type: "done",
    message: `Crawl complete: ${crawledCount} pages mapped`,
    totalCrawled: crawledCount,
    totalQueued: crawledCount,
  };
}

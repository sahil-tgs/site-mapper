import { XMLParser } from "fast-xml-parser";
import type { SitemapEntry } from "@/types";

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
});

const MAX_ENTRIES = 800;
const MAX_DEPTH = 3;

function normalizeToArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

export async function fetchAndParseSitemap(
  url: string,
  depth = 0
): Promise<SitemapEntry[]> {
  if (depth > MAX_DEPTH) return [];

  const response = await fetch(url, {
    headers: { "User-Agent": "SiteMapper/1.0" },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status}`);
  }

  const text = await response.text();
  const parsed = parser.parse(text);

  // Handle sitemap index
  if (parsed.sitemapindex) {
    const sitemaps = normalizeToArray(parsed.sitemapindex.sitemap);
    const entries: SitemapEntry[] = [];

    for (const sitemap of sitemaps) {
      if (entries.length >= MAX_ENTRIES) break;
      const loc = typeof sitemap === "string" ? sitemap : sitemap.loc;
      if (!loc) continue;
      try {
        const subEntries = await fetchAndParseSitemap(loc, depth + 1);
        entries.push(...subEntries);
      } catch {
        // Skip failed sub-sitemaps
      }
    }

    return entries.slice(0, MAX_ENTRIES);
  }

  // Handle urlset
  if (parsed.urlset) {
    const urls = normalizeToArray(parsed.urlset.url);
    return urls.slice(0, MAX_ENTRIES).map((u) => ({
      loc: typeof u === "string" ? u : u.loc,
      lastmod: u?.lastmod,
      changefreq: u?.changefreq,
      priority: u?.priority != null ? Number(u.priority) : undefined,
    }));
  }

  throw new Error("Invalid sitemap XML: no <urlset> or <sitemapindex> found");
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SiteTreeNode {
  id: string;
  label: string;
  fullUrl: string;
  children: SiteTreeNode[];
  isIntermediate: boolean;
}

export interface SitemapResponse {
  entries: SitemapEntry[];
  tree: SiteTreeNode;
  domain: string;
  totalUrls: number;
}

// Crawl-based page with explicit link edges
export interface CrawledPage {
  url: string;
  title: string;
  links: string[];
  depth: number;
}

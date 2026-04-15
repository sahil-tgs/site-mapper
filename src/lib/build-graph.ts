import type { CrawledPage } from "@/types";

export interface GraphData {
  nodes: {
    id: string;
    label: string;
    fullUrl: string;
    title: string;
    linkCount: number;
    depth: number;
    isRoot: boolean;
  }[];
  edges: {
    source: string;
    target: string;
  }[];
}

export function buildGraphFromCrawl(
  pages: CrawledPage[],
  startUrl: string
): GraphData {
  const nodeSet = new Set<string>();
  const nodes: GraphData["nodes"] = [];
  const edges: GraphData["edges"] = [];
  const edgeSet = new Set<string>();

  // Add all crawled pages as nodes
  for (const page of pages) {
    if (nodeSet.has(page.url)) continue;
    nodeSet.add(page.url);

    const label = urlToLabel(page.url);
    nodes.push({
      id: page.url,
      label: page.title || label,
      fullUrl: page.url,
      title: page.title || label,
      linkCount: page.links.length,
      depth: page.depth,
      isRoot: page.url === startUrl,
    });
  }

  // Add edges from page -> linked pages (only if both exist as nodes)
  for (const page of pages) {
    for (const link of page.links) {
      if (!nodeSet.has(link)) continue;
      const key = `${page.url}->${link}`;
      if (edgeSet.has(key)) continue;
      // Skip self-links
      if (page.url === link) continue;
      edgeSet.add(key);
      edges.push({ source: page.url, target: link });
    }
  }

  return { nodes, edges };
}

function urlToLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    if (!path || path === "") return u.hostname;
    const segments = path.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return decodeURIComponent(last).replace(/[-_]/g, " ");
  } catch {
    return url;
  }
}

import type { SitemapEntry, SiteTreeNode } from "@/types";

export function buildTree(
  entries: SitemapEntry[],
  domain: string
): SiteTreeNode {
  const root: SiteTreeNode = {
    id: "/",
    label: new URL(domain).hostname,
    fullUrl: domain,
    children: [],
    isIntermediate: false,
  };

  const nodeMap = new Map<string, SiteTreeNode>();
  nodeMap.set("/", root);

  // Collect all paths from entries
  const entryPaths = new Set<string>();
  for (const entry of entries) {
    try {
      const url = new URL(entry.loc);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      entryPaths.add(path);
    } catch {
      // skip invalid URLs
    }
  }

  // Sort paths so parents are created before children
  const sortedPaths = Array.from(entryPaths).sort();

  for (const path of sortedPaths) {
    if (path === "/") {
      root.isIntermediate = false;
      continue;
    }

    const segments = path.split("/").filter(Boolean);
    let currentPath = "";

    for (let i = 0; i < segments.length; i++) {
      const parentPath = currentPath || "/";
      currentPath += "/" + segments[i];
      const isLast = i === segments.length - 1;

      if (!nodeMap.has(currentPath)) {
        const entry = entries.find((e) => {
          try {
            const p = new URL(e.loc).pathname.replace(/\/+$/, "");
            return p === currentPath;
          } catch {
            return false;
          }
        });

        const node: SiteTreeNode = {
          id: currentPath,
          label: decodeURIComponent(segments[i]),
          fullUrl: entry ? entry.loc : `${domain}${currentPath}`,
          children: [],
          isIntermediate: !isLast && !entryPaths.has(currentPath),
        };

        nodeMap.set(currentPath, node);
        const parent = nodeMap.get(parentPath);
        if (parent) {
          parent.children.push(node);
        }
      } else if (isLast) {
        // Mark existing intermediate node as real
        const existing = nodeMap.get(currentPath)!;
        existing.isIntermediate = false;
      }
    }
  }

  return root;
}

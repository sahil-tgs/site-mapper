"use client";

import { useState, useRef, useCallback } from "react";
import { SiteGraph, type GraphInput } from "@/components/SiteGraph";
import type { SiteTreeNode, CrawledPage } from "@/types";
import { buildGraphFromCrawl } from "@/lib/build-graph";

type Mode = "idle" | "loading" | "crawling" | "done";

function treeToGraphInput(tree: SiteTreeNode): GraphInput {
  const nodes: GraphInput["nodes"] = [];
  const edges: GraphInput["edges"] = [];

  function walk(n: SiteTreeNode, depth: number) {
    nodes.push({
      id: n.id,
      label: n.label,
      fullUrl: n.fullUrl,
      isRoot: depth === 0,
      linkCount: n.children.length,
    });
    for (const child of n.children) {
      edges.push({ source: n.id, target: child.id });
      walk(child, depth + 1);
    }
  }
  walk(tree, 0);
  return { nodes, edges };
}

function detectMode(url: string): "sitemap" | "crawl" {
  const lower = url.toLowerCase();
  if (lower.includes("sitemap") && lower.endsWith(".xml")) return "sitemap";
  if (lower.endsWith(".xml")) return "sitemap";
  return "crawl";
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("idle");
  const [graph, setGraph] = useState<GraphInput | null>(null);
  const [graphKey, setGraphKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ crawled: 0, queued: 0, status: "" });
  const [totalPages, setTotalPages] = useState(0);
  const [domain, setDomain] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const handleSitemapFetch = useCallback(async (inputUrl: string) => {
    setMode("loading");
    setError(null);

    try {
      const res = await fetch("/api/sitemap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: inputUrl }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to fetch sitemap");

      const graphData = treeToGraphInput(json.tree);
      setGraph(graphData);
      setGraphKey(Date.now().toString());
      setTotalPages(json.totalUrls);
      setDomain(json.domain);
      setMode("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setMode("idle");
    }
  }, []);

  const handleCrawl = useCallback(async (inputUrl: string) => {
    setMode("crawling");
    setError(null);
    setStats({ crawled: 0, queued: 0, status: "Starting crawl..." });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: inputUrl, maxPages: 300 }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || "Crawl failed");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const pages: CrawledPage[] = [];
      let startUrl = inputUrl.replace(/\/+$/, "") || inputUrl;

      // Normalize start URL same way crawler does
      try {
        const u = new URL(inputUrl);
        u.hash = "";
        u.pathname = u.pathname.replace(/\/+$/, "") || "/";
        startUrl = u.toString();
        setDomain(u.origin);
      } catch { /* */ }

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === "page" && event.url) {
              pages.push({
                url: event.url,
                title: event.title || "",
                links: event.links || [],
                depth: event.depth || 0,
              });
            }

            if (event.totalCrawled != null) {
              setStats({
                crawled: event.totalCrawled,
                queued: event.totalQueued || 0,
                status: event.message || `Crawled ${event.totalCrawled} pages...`,
              });
            }

            // Update graph every 10 pages for live visualization
            if (event.type === "page" && pages.length % 10 === 0 && pages.length > 0) {
              const liveGraph = buildGraphFromCrawl(pages, startUrl);
              setGraph(liveGraph);
              setGraphKey(`live-${pages.length}`);
            }

            if (event.type === "done") {
              const finalGraph = buildGraphFromCrawl(pages, startUrl);
              setGraph(finalGraph);
              setGraphKey(`final-${pages.length}`);
              setTotalPages(pages.length);
              setMode("done");
            }

            if (event.type === "error" && !event.url) {
              throw new Error(event.error);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Final graph if "done" event wasn't received
      if (mode !== "done" && pages.length > 0) {
        const finalGraph = buildGraphFromCrawl(pages, startUrl);
        setGraph(finalGraph);
        setGraphKey(`final-${pages.length}`);
        setTotalPages(pages.length);
        setMode("done");
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Crawl failed");
      setMode("idle");
    }
  }, [mode]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    // Cancel any running crawl
    abortRef.current?.abort();

    const inputMode = detectMode(trimmed);
    if (inputMode === "sitemap") {
      handleSitemapFetch(trimmed);
    } else {
      handleCrawl(trimmed);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setMode("done");
  }

  function handleClear() {
    abortRef.current?.abort();
    setGraph(null);
    setMode("idle");
    setError(null);
    setStats({ crawled: 0, queued: 0, status: "" });
    setTotalPages(0);
    setDomain("");
  }

  const isActive = mode !== "idle";
  const isWorking = mode === "loading" || mode === "crawling";

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {!isActive ? (
        /* ─── Hero state ─── */
        <div className="flex-1 flex flex-col items-center justify-center px-4 gap-8">
          <div className="text-center space-y-3">
            <h1 className="text-4xl font-bold bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
              Site Mapper
            </h1>
            <p className="text-zinc-400 text-lg max-w-lg">
              Visualize any website&apos;s structure as an interactive graph.
              Paste a sitemap URL or any website URL to crawl it.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex gap-3 w-full max-w-xl">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com or .../sitemap.xml"
              required
              className="flex-1 px-4 py-3 rounded-xl bg-zinc-800/80 border border-zinc-700/60 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-all text-sm"
            />
            <button
              type="submit"
              className="px-6 py-3 rounded-xl font-medium text-sm bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-lg shadow-purple-500/20 transition-all whitespace-nowrap"
            >
              Map Site
            </button>
          </form>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2.5 rounded-xl text-sm max-w-xl">
              {error}
            </div>
          )}

          <div className="text-zinc-600 text-xs space-y-1 text-center">
            <div>Paste a sitemap.xml URL for instant mapping, or any URL to deep-crawl the site</div>
            <div className="text-zinc-700">
              Try: https://www.tryrankly.com/sitemap.xml &middot; https://www.tryprofound.com/
            </div>
          </div>
        </div>
      ) : (
        /* ─── Graph state ─── */
        <>
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/60 bg-zinc-900/80 backdrop-blur-md shrink-0">
            <h1 className="text-lg font-semibold bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent whitespace-nowrap">
              Site Mapper
            </h1>

            <form onSubmit={handleSubmit} className="flex gap-2 flex-1 max-w-lg">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                required
                disabled={isWorking}
                className="flex-1 px-3 py-2 rounded-lg bg-zinc-800/80 border border-zinc-700/60 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all text-sm disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={isWorking}
                className="px-4 py-2 rounded-lg font-medium text-xs bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 text-white transition-all whitespace-nowrap"
              >
                Map
              </button>
            </form>

            <div className="flex items-center gap-3 ml-auto shrink-0">
              {/* Live crawl progress */}
              {mode === "crawling" && (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
                    </span>
                    <span className="text-xs text-zinc-400">
                      {stats.crawled} crawled
                    </span>
                  </div>
                  <button
                    onClick={handleStop}
                    className="text-xs px-2 py-1 rounded bg-zinc-800 text-red-400 hover:bg-zinc-700 transition-colors"
                  >
                    Stop
                  </button>
                </div>
              )}

              {mode === "loading" && (
                <div className="flex items-center gap-1.5">
                  <svg className="animate-spin h-3.5 w-3.5 text-purple-400" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-xs text-zinc-400">Loading sitemap...</span>
                </div>
              )}

              {mode === "done" && (
                <span className="bg-zinc-800 px-2.5 py-1 rounded-lg text-xs font-mono text-zinc-300">
                  {totalPages} pages
                </span>
              )}

              {domain && (
                <span className="text-zinc-600 truncate max-w-[180px] text-xs">
                  {domain}
                </span>
              )}

              <button
                onClick={handleClear}
                className="text-zinc-500 hover:text-zinc-300 transition-colors text-xs"
              >
                Clear
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm shrink-0">
              {error}
            </div>
          )}

          <div className="flex-1 relative">
            {graph && graph.nodes.length > 0 ? (
              <SiteGraph graph={graph} graphKey={graphKey} />
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-3">
                  <svg className="animate-spin h-8 w-8 text-purple-500 mx-auto" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <p className="text-zinc-500 text-sm">{stats.status || "Analyzing site..."}</p>
                </div>
              </div>
            )}

            {/* Crawl progress overlay */}
            {mode === "crawling" && (
              <div className="absolute top-3 right-3 bg-zinc-900/90 border border-zinc-800 rounded-xl px-4 py-3 text-xs space-y-1 backdrop-blur-md">
                <div className="text-zinc-300 font-medium">Crawling...</div>
                <div className="text-zinc-500">{stats.status}</div>
                <div className="flex gap-4 text-zinc-400">
                  <span>{stats.crawled} discovered</span>
                  <span>{graph?.nodes.length || 0} mapped</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

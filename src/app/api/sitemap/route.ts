import { NextResponse } from "next/server";
import { fetchAndParseSitemap } from "@/lib/parse-sitemap";
import { buildTree } from "@/lib/build-tree";

export async function POST(request: Request) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { error: "Please provide a valid sitemap URL" },
        { status: 400 }
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json(
        { error: "Invalid URL format" },
        { status: 400 }
      );
    }

    const entries = await fetchAndParseSitemap(url);

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "No URLs found in the sitemap" },
        { status: 400 }
      );
    }

    const domain = parsedUrl.origin;
    const tree = buildTree(entries, domain);

    return NextResponse.json({
      entries,
      tree,
      domain,
      totalUrls: entries.length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to process sitemap";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

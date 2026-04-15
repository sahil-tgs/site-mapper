import { crawl } from "@/lib/crawler";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min max for Vercel, ignored locally

export async function POST(request: Request) {
  let url: string;
  let maxPages: number;

  try {
    const body = await request.json();
    url = body.url;
    maxPages = body.maxPages || 300;

    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Provide a valid URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    new URL(url); // validate
  } catch {
    return new Response(JSON.stringify({ error: "Invalid URL format" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of crawl(url, { maxPages })) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Crawl failed";
        const data = `data: ${JSON.stringify({ type: "error", error: msg })}\n\n`;
        controller.enqueue(encoder.encode(data));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let cached: Promise<Handler> | undefined;

function loadApp(): Promise<Handler> {
  if (!cached) {
    cached = import("../server/app").then((mod) => mod.default as unknown as Handler);
  }
  return cached;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: Handler;

  try {
    app = await loadApp();
  } catch (err) {
    cached = undefined;
    const error = err as Error;
    console.error("[startup] the API failed to load", error);

    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "startup_failed",
        name: error?.name ?? "Error",
        message: error?.message ?? String(err),
      }),
    );
    return;
  }

  app(req, res);
}

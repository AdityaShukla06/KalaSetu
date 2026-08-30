import { Request } from "express";

export class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Upload exceeds the ${Math.round(limitBytes / (1024 * 1024))}MB limit`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Reads the request body as a Buffer in a way that works both under a normal
 * Express server and under a serverless runtime that has already buffered and
 * consumed the request stream.
 */
export async function readRawBody(req: Request, limitBytes: number): Promise<Buffer> {
  const existing = (req as Request & { body?: unknown }).body;

  if (Buffer.isBuffer(existing)) {
    if (existing.length > limitBytes) throw new PayloadTooLargeError(limitBytes);
    return existing;
  }

  if (typeof existing === "string" && existing.length > 0) {
    const buffer = Buffer.from(existing, "binary");
    if (buffer.length > limitBytes) throw new PayloadTooLargeError(limitBytes);
    return buffer;
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new PayloadTooLargeError(limitBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function requestedContentType(req: Request, fallback: string): string {
  const header = req.get("x-file-type") || req.get("content-type") || "";
  const bare = header.split(";")[0].trim().toLowerCase();
  return bare && bare !== "application/octet-stream" ? bare : fallback;
}

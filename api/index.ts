import type { IncomingMessage, ServerResponse } from "node:http";
import app from "../server/app";

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}

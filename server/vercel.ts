import type { IncomingMessage, ServerResponse } from "node:http";
import app from "./app";

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  (app as unknown as NodeHandler)(req, res);
}

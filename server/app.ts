import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import healthRouter from "./routes/health";
import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import productsRouter from "./routes/products";
import imagesRouter from "./routes/images";
import voiceRouter from "./routes/voice";
import translateRouter from "./routes/translate";
import pricingRouter from "./routes/pricing";
import inquiriesRouter from "./routes/inquiries";
import internalConsoleRouter from "./routes/internalConsole";
import { PayloadTooLargeError } from "./middleware/rawBody";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/products", productsRouter);
app.use("/api/images", imagesRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/translate", translateRouter);
app.use("/api/pricing", pricingRouter);
app.use("/api/inquiries", inquiriesRouter);
app.use("/api/internal/console", internalConsoleRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof PayloadTooLargeError) {
    res.status(413).json({ error: "payload_too_large", message: err.message });
    return;
  }

  console.error("Unhandled request error", err);
  res.status(500).json({ error: "internal_error" });
});

export default app;

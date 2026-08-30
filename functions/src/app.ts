import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import healthRouter from "./routes/health";
import usersRouter from "./routes/users";
import productsRouter from "./routes/products";
import imagesRouter from "./routes/images";
import voiceRouter from "./routes/voice";
import pricingRouter from "./routes/pricing";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/users", usersRouter);
app.use("/api/products", productsRouter);
app.use("/api/images", imagesRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/pricing", pricingRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({ error: "upload_rejected", message: err.message });
    return;
  }

  console.error("Unhandled request error", err);
  res.status(500).json({ error: "internal_error" });
});

export default app;

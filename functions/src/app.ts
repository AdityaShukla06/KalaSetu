import express from "express";
import cors from "cors";
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

export default app;

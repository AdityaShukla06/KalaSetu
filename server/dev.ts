import "dotenv/config";
import app from "./app";

const port = Number(process.env.API_DEV_PORT) || 8787;

app.listen(port, () => {
  console.log(`API dev server listening on http://localhost:${port}`);
});

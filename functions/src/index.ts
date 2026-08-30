import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import app from "./app";

initializeApp();

export const api = onRequest({ secrets: ["GEMINI_API_KEY"] }, app);

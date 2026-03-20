// auth-service/server/index.ts
// Standalone Express app — handles ONLY auth for all MEH Moscow apps.
// Deploy this as its own Railway service from a new repo: meh-auth

import express from "express";
import { setupAuth } from "./auth";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, service: "meh-auth" }));

setupAuth(app);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[meh-auth] Running on port ${PORT}`);
});

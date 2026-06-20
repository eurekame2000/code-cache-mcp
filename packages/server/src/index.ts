#!/usr/bin/env bun
import { startMcpServer } from "./mcp.js";

startMcpServer().catch((err) => {
  console.error("Failed to start code-cache-mcp:", err);
  process.exit(1);
});

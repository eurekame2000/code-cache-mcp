// MetricsMonitor removed in v0.2.0 — stripped for lighter weight.
// No-op stub for backward compatibility.

export class MetricsMonitor {
  constructor() {}
  async record(): Promise<void> {}
  async close(): Promise<void> {}
}

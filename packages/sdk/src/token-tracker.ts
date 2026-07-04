// TokenTracker removed in v0.2.0 — stripped for lighter weight.
// No-op stub for backward compatibility.

export class TokenTracker {
  constructor() {}
  async count(): Promise<number> { return 0; }
  static estimate(text: string): number { return Math.ceil(text.length / 4); }
}

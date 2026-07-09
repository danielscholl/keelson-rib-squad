import type { TokenUsage } from "@keelson/shared";

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatUsageTail(usage: TokenUsage): string {
  return `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`;
}

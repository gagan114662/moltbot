const MIN_SATURATION_RESET_REMAINING_TOKENS = 1_024;
const MAX_RESERVE_FLOOR_APPLIED_TOKENS = 2_000;

type SessionSaturationParams = {
  totalTokens?: number;
  contextTokens?: number;
  reserveTokensFloor?: number;
  isNewSession?: boolean;
};

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized < 0) {
    return undefined;
  }
  return normalized;
}

export function shouldResetSaturatedSession(params: SessionSaturationParams): boolean {
  if (params.isNewSession) {
    return false;
  }
  const totalTokens = normalizeNonNegativeInt(params.totalTokens);
  const contextTokens = normalizeNonNegativeInt(params.contextTokens);
  if (!totalTokens || !contextTokens || contextTokens <= 0) {
    return false;
  }

  if (totalTokens >= contextTokens) {
    return true;
  }

  const reserveFloor = normalizeNonNegativeInt(params.reserveTokensFloor) ?? 0;
  const resetThreshold = Math.max(
    MIN_SATURATION_RESET_REMAINING_TOKENS,
    Math.min(MAX_RESERVE_FLOOR_APPLIED_TOKENS, reserveFloor),
  );
  const remaining = Math.max(0, contextTokens - totalTokens);
  return remaining <= resetThreshold;
}

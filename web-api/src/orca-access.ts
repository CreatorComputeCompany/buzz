export type OrcaAccessEnvironment = {
  BUZZ_ORCA_ACCESS_MODE?: string;
  BUZZ_ORCA_ALLOWED_USER_IDS?: string;
};

export function isOrcaRuntimeUserAllowed(
  userId: string,
  environment: OrcaAccessEnvironment = process.env,
): boolean {
  const mode = environment.BUZZ_ORCA_ACCESS_MODE ?? "allowlist";
  if (mode === "authenticated") return true;
  if (mode !== "allowlist") return false;
  return new Set(
    (environment.BUZZ_ORCA_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ).has(userId);
}

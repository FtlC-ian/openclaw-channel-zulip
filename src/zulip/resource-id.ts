export function validateZulipResourceId(value: unknown, field = "resourceId"): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) ||
    !Number.isSafeInteger(Number(value)) || Number(value) <= 0
  ) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return String(value);
}

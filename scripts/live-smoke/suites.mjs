export function selectSmokeSuite(value) {
  if (value === undefined) return "full";
  if (value === "full" || value === "bindings") return value;
  throw new Error("ZULIP_SMOKE_SUITE must be full or bindings (or omitted)");
}

export async function dispatchSmokeSuite(suite, { full, bindings }) {
  const selected = selectSmokeSuite(suite);
  if (selected === "full") await full();
  await bindings();
}

import { describe, expect, it } from "vitest";
import { createZulipDurableInboundMessageId, fingerprintZulipDurableInboundIdentity } from "./durable-receive.js";

describe("durable inbound identity", () => {
  const identity = { realmUrl: "https://ZULIP.example:443/path/", botUserId: 17 };
  it("canonicalizes URL origins, but distinguishes realm, port, scheme and authenticated bot", () => {
    const fingerprint = fingerprintZulipDurableInboundIdentity(identity);
    expect(fingerprintZulipDurableInboundIdentity({ ...identity, realmUrl: "https://zulip.example" })).toBe(fingerprint);
    for (const changed of [
      { ...identity, realmUrl: "https://other.example" },
      { ...identity, realmUrl: "https://zulip.example:8443" },
      { ...identity, realmUrl: "http://zulip.example" },
      { ...identity, botUserId: 18 },
    ]) expect(fingerprintZulipDurableInboundIdentity(changed)).not.toBe(fingerprint);
  });
  it("keeps stable dedupe IDs within one identity and separates account, message, realm and bot", () => {
    const params = { accountId: "default", messageId: "42", identity };
    const id = createZulipDurableInboundMessageId(params);
    expect(createZulipDurableInboundMessageId({ ...params, identity: { ...identity, realmUrl: "https://zulip.example/" } })).toBe(id);
    for (const changed of [
      { ...params, accountId: "second" },
      { ...params, messageId: "43" },
      { ...params, identity: { ...identity, realmUrl: "https://other.example" } },
      { ...params, identity: { ...identity, botUserId: 18 } },
    ]) expect(createZulipDurableInboundMessageId(changed)).not.toBe(id);
  });
});

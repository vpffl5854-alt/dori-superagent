import { describe, expect, test } from "bun:test";
import { formatInbound } from "../src/messenger/discord-inbound.ts";

describe("DiscordInbound line format", () => {
  test("the line carries the whole text, so a long message is distinguishable from a short one", () => {
    const text = "x".repeat(4000);
    const line = formatInbound({
      source: "guild",
      channel: "c1",
      guild: "g1",
      messageId: "9",
      author: "someone",
      authorIsBot: false,
      text,
    });

    expect(line).toContain(JSON.stringify(text));
    expect(line.split("\n")).toHaveLength(1);
  });
});

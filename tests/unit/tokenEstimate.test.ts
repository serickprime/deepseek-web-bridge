import { describe, expect, it } from "vitest";
import { estimateChatTokenCount, estimateTokenCount, hasCjk } from "../../src/utils/tokenEstimate.js";

describe("tokenEstimate", () => {
  it("estimates latin text", () => {
    const count = estimateTokenCount("hello world this is a test");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20);
  });

  it("detects CJK text", () => {
    expect(hasCjk("Привет, мир")).toBe(false);
    expect(hasCjk("你好世界")).toBe(true);
  });

  it("estimates chat tokens for messages", () => {
    const count = estimateChatTokenCount([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(count).toBeGreaterThan(0);
  });

  it("handles empty input", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateChatTokenCount([])).toBe(0);
  });
});

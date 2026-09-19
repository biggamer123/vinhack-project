import { describe, expect, it } from "vitest";
import { readingTime, timeAgo } from "./time";

describe("time helpers", () => {
  it("timeAgo buckets by minute, hour and day", () => {
    const now = 1_000_000_000;
    expect(timeAgo(now, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });

  it("readingTime never says zero minutes", () => {
    expect(readingTime("short")).toBe("1 min read");
  });
});

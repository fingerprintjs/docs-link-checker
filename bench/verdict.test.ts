import { describe, expect, it } from "vitest";
import { median, summarize, verdictForTime } from "./verdict";

describe("median()", () => {
  it("returns the middle value for an odd-length array, regardless of input order", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5, 1, 3, 2, 4])).toBe(3);
  });

  it("averages the two middle values for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns the single value for a one-element array", () => {
    expect(median([42])).toBe(42);
  });
});

describe("summarize()", () => {
  it("reports median, min and max of the values", () => {
    expect(summarize([10, 20, 30])).toEqual({ median: 20, min: 10, max: 30 });
  });
});

describe("verdictForTime()", () => {
  it("is 'same' for a small absolute difference even with a large relative one", () => {
    // 100ms -> 200ms is +100% but well under the 5s absolute bar
    expect(verdictForTime(100, 200)).toBe("same");
  });

  it("is 'same' for a large absolute difference that is a small relative change", () => {
    // 10 minutes -> 10 minutes + 6s is +6s but only ~1%, under the 15% relative bar
    expect(verdictForTime(600_000, 606_000)).toBe("same");
  });

  it("is 'worse' when head clears both the relative and absolute thresholds", () => {
    expect(verdictForTime(10_000, 20_000)).toBe("worse");
  });

  it("is 'better' when head clears both thresholds in the other direction", () => {
    expect(verdictForTime(20_000, 10_000)).toBe("better");
  });

  it("handles a base of 0 without dividing by zero", () => {
    expect(verdictForTime(0, 0)).toBe("same");
    expect(verdictForTime(0, 6000)).toBe("worse");
  });
});

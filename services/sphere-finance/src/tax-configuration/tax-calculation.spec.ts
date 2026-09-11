import { calculateTaxAmountMinor } from "./tax-calculation";

describe("calculateTaxAmountMinor", () => {
  it("calculates a simple 5% rate exactly", () => {
    // 5.00% == 500 basis points
    expect(calculateTaxAmountMinor(10000, 500)).toBe(500);
  });

  it("returns 0 for a 0 basis-point (zero-rated/exempt) rate", () => {
    expect(calculateTaxAmountMinor(10000, 0)).toBe(0);
  });

  it("returns 0 for a 0 amountMinor", () => {
    expect(calculateTaxAmountMinor(0, 500)).toBe(0);
  });

  it("rounds down when the fractional remainder is below half", () => {
    // 333 * 500 / 10000 = 16.65 -> 17 (half-up); use a case clearly below .5
    // 101 * 500 / 10000 = 5.05 -> 5
    expect(calculateTaxAmountMinor(101, 500)).toBe(5);
  });

  it("rounds half up at the exact .5 boundary", () => {
    // 1 * 500 / 10000 wouldn't hit .5 cleanly; construct an exact .5 case:
    // amountMinor * rateBasisPoints / 10000 = X.5
    // 10 * 500 / 10000 = 0.5 -> rounds to 1 (half-up)
    expect(calculateTaxAmountMinor(10, 500)).toBe(1);
  });

  it("rounds up when the fractional remainder is above half", () => {
    // 199 * 500 / 10000 = 9.95 -> 10
    expect(calculateTaxAmountMinor(199, 500)).toBe(10);
  });

  it("handles a 100% rate (10000 basis points) as a pass-through", () => {
    expect(calculateTaxAmountMinor(12345, 10000)).toBe(12345);
  });

  it("handles large minor-unit amounts without precision loss", () => {
    // 123456789 minor units at 5% — well within Number.isSafeInteger range.
    expect(calculateTaxAmountMinor(123456789, 500)).toBe(6172839);
  });
});

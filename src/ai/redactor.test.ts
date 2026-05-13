import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { userName: "Alpaca A" },
}));

vi.mock("./context.js", () => ({
  readContext: vi.fn().mockReturnValue(
    `## Family
- Partner: Corgi

## Income
- 80,000 THB/month from Zentry Thailand Co.
`,
  ),
}));

import { redact, unredact } from "./redactor.js";

describe("redact", () => {
  it("redacts user full name", () => {
    expect(redact("Alpaca sent 1,000 baht")).toBe("[USER] sent 1,000 baht");
  });

  it("redacts user first and last names", () => {
    expect(redact("Hi Alpaca, Mr. A")).toBe("Hi [USER_FIRST], Mr. [USER_LAST]");
  });

  it("redacts partner names from context", () => {
    expect(redact("Transfer to Corgi")).toBe("Transfer to [PARTNER]");
  });

  it("redacts employer", () => {
    expect(redact("Salary from Zentry Thailand Co.")).toBe(
      "Salary from [EMPLOYER]",
    );
  });

  it("redacts Thai national ID with dashes", () => {
    expect(redact("ID: 1-2345-67890-12-3")).toBe("ID: [NATID]");
  });

  it("redacts Thai national ID without dashes", () => {
    expect(redact("ID 1234567890123 issued")).toBe("ID [NATID] issued");
  });

  it("redacts Thai mobile numbers", () => {
    expect(redact("Call 0812345678 for assistance")).toBe(
      "Call [PHONE] for assistance",
    );
  });

  it("redacts 16-digit credit card numbers", () => {
    expect(redact("Card 4111 1111 1111 1111")).toBe("Card [CARD]");
  });

  it("leaves clean text alone", () => {
    expect(redact("The weather is hot in Bangkok today")).toBe(
      "The weather is hot in Bangkok today",
    );
  });
});

describe("unredact", () => {
  it("restores tokens", () => {
    expect(unredact("Hello [USER]")).toBe("Hello Alpaca A");
  });
});

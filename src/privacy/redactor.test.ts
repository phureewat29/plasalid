import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { userName: "Alpaca Beagle" },
}));

vi.mock("../context.js", () => ({
  readContext: vi.fn().mockReturnValue(
    `## Family
- Partner: Corgi

## Income
- 80,000 THB/month from Zentry Thailand Co.
`,
  ),
}));

import { redact, applyRedaction } from "./redactor.js";

describe("redact", () => {
  it("redacts user full name", () => {
    expect(redact("Alpaca Beagle sent 1,000 baht")).toBe("[USER] sent 1,000 baht");
  });

  it("redacts user first and last names", () => {
    expect(redact("Hi Alpaca, Mr. Beagle")).toBe("Hi [USER_FIRST], Mr. [USER_LAST]");
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

describe("applyRedaction", () => {
  it("is an identity no-op when disabled", () => {
    const data = { memo: "call 0812345678", account_id: "asset:kbank" };
    expect(applyRedaction(data, false, ["memo"])).toBe(data);
  });

  it("redacts allowlisted string fields but leaves other fields verbatim", () => {
    const row = {
      account_id: "asset:0812345678", // would match [PHONE] but is NOT allowlisted
      memo: "refund to 0812345678",
      currency: "THB",
    };
    const out = applyRedaction(row, true, ["memo"]);
    expect(out.memo).toBe("refund to [PHONE]");
    // ids/enums must survive untouched even when they contain digits.
    expect(out.account_id).toBe("asset:0812345678");
    expect(out.currency).toBe("THB");
  });

  it("deep-walks nested objects and arrays", () => {
    const detail = {
      id: "tx:1",
      description: "salary 1-2345-67890-12-3",
      postings: [
        { id: "p:1", account_id: "asset:kbank", memo: "card 4111 1111 1111 1111" },
        { id: "p:2", account_id: "expense:food", memo: null },
      ],
    };
    const out = applyRedaction(detail, true, ["description", "memo"]);
    expect(out.description).toBe("salary [NATID]");
    expect(out.postings[0].memo).toBe("card [CARD]");
    expect(out.postings[0].account_id).toBe("asset:kbank");
    expect(out.postings[1].memo).toBeNull();
    expect(out.id).toBe("tx:1");
  });

  it("does not mutate the input", () => {
    const row = { memo: "0812345678" };
    const out = applyRedaction(row, true, ["memo"]);
    expect(row.memo).toBe("0812345678");
    expect(out.memo).toBe("[PHONE]");
  });
});

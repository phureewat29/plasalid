import { describe, it, expect } from "vitest";
import { rasterizePage } from "./rasterize.js";

/**
 * Hand-rolled 1-page PDF (612×792) so the test doesn't need a fixture file.
 * Byte offsets are precomputed for the xref table — if you edit the bodies,
 * recompute them.
 */
function minimalPdf(): Buffer {
  const header = "%PDF-1.4\n";
  const o1 = "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
  const o2 = "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n";
  const o3 =
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\n";

  const offset1 = header.length;
  const offset2 = offset1 + o1.length;
  const offset3 = offset2 + o2.length;
  const xrefStart = offset3 + o3.length;

  const xref =
    `xref\n0 4\n` +
    `0000000000 65535 f \n` +
    `${String(offset1).padStart(10, "0")} 00000 n \n` +
    `${String(offset2).padStart(10, "0")} 00000 n \n` +
    `${String(offset3).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer<</Size 4/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(header + o1 + o2 + o3 + xref + trailer, "latin1");
}

describe("rasterizePage", () => {
  it("renders a one-page PDF to a PNG buffer", async () => {
    const result = await rasterizePage(minimalPdf(), { dpi: 72 });
    expect(result.mime).toBe("image/png");
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(result.bytes[0]).toBe(0x89);
    expect(result.bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(result.bytes.length).toBeGreaterThan(100);
  });
});

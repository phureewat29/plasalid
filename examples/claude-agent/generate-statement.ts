/**
 * Generates a synthetic, fictional one-page bank-statement PDF with VISIBLE
 * text, using hand-assembled PDF bytes — no PDF-writing dependency.
 *
 * Pattern reference: `minimalPdf()` in src/scanner/pdf.test.ts builds a valid
 * empty PDF (Catalog/Pages/Page + xref + trailer). This script extends that
 * technique with two more objects: a /Font resource (Helvetica, WinAnsi) and
 * a content stream that paints text via BT/Tf/Td/Tj/ET operators.
 *
 * All amounts/dates below are constants, so the output is byte-for-byte
 * deterministic across runs.
 *
 * Usage:
 *   npx tsx examples/claude-agent/generate-statement.ts <output.pdf>
 *
 * The script ends with a self-check: it opens the PDF it just wrote with
 * mupdf, confirms it has exactly one page, and confirms the extracted page
 * text contains "KASI BANK". Prints OK/FAIL and exits non-zero on FAIL.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// --- fictional bank statement content --------------------------------------
// KASI BANK is not a real financial institution. This statement is synthetic
// and exists only to exercise the plasalid ingest → commit pipeline end to end.

const BANK_NAME = "KASI BANK - SAVINGS ACCOUNT STATEMENT";
const ACCOUNT_LINE = "Account: 123-4-56789-0  Period: 01/06/2026 - 30/06/2026";
const TABLE_HEADER =
  "DATE        DESCRIPTION                    WITHDRAWAL        DEPOSIT       BALANCE";

/** Opening balance carried into the statement period (constant, for determinism). */
const OPENING_BALANCE = 12743.25;

interface TxRow {
  date: string; // DD/MM/YYYY
  description: string;
  withdrawal: number | null;
  deposit: number | null;
}

// Plausible Thai-life transactions in THB, Gregorian dates within the
// statement period. Ends exactly at a round 50,000.00 balance by construction.
const TRANSACTIONS: TxRow[] = [
  { date: "01/06/2026", description: "SALARY DEPOSIT", withdrawal: null, deposit: 45000.0 },
  { date: "03/06/2026", description: "7-ELEVEN", withdrawal: 189.5, deposit: null },
  { date: "05/06/2026", description: "GRAB RIDE", withdrawal: 127.0, deposit: null },
  { date: "10/06/2026", description: "ELECTRICITY MCEA", withdrawal: 1842.75, deposit: null },
  { date: "15/06/2026", description: "TRANSFER TO SAVINGS", withdrawal: 5000.0, deposit: null },
  { date: "20/06/2026", description: "STARBUCKS", withdrawal: 165.0, deposit: null },
  { date: "25/06/2026", description: "NETFLIX", withdrawal: 419.0, deposit: null },
];

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Builds the plain-text lines of the statement, one line per array entry.
 * Column alignment is monospaced-ish via manual space padding (Helvetica is
 * proportional, so this is approximate, not pixel-perfect) — one Tj per line.
 */
function buildLines(): string[] {
  const lines: string[] = [BANK_NAME, ACCOUNT_LINE, "", TABLE_HEADER];
  let balance = OPENING_BALANCE;
  for (const tx of TRANSACTIONS) {
    if (tx.withdrawal != null) balance -= tx.withdrawal;
    if (tx.deposit != null) balance += tx.deposit;
    const withdrawalCol = tx.withdrawal != null ? fmt(tx.withdrawal) : "";
    const depositCol = tx.deposit != null ? fmt(tx.deposit) : "";
    lines.push(
      `${tx.date}  ${tx.description.padEnd(26)}  ${withdrawalCol.padStart(12)}  ` +
        `${depositCol.padStart(12)}  ${fmt(balance).padStart(12)}`,
    );
  }
  return lines;
}

/** Escapes PDF literal-string special characters: backslash and parens. */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Builds the page content stream: one BT/ET block, one Tj per non-blank line. */
function buildContentStream(lines: string[]): string {
  const ops: string[] = ["BT", "/F1 10 Tf", "50 740 Td"];
  lines.forEach((line, i) => {
    if (i > 0) ops.push("0 -14 Td");
    if (line.length > 0) ops.push(`(${pdfEscape(line)}) Tj`);
  });
  ops.push("ET");
  return ops.join("\n") + "\n";
}

/**
 * Assembles a complete single-page PDF from hand-written objects, tracking
 * byte offsets as it goes (same technique as minimalPdf(), extended with a
 * Font object and a content-stream object).
 */
function buildPdf(lines: string[]): Buffer {
  const content = buildContentStream(lines);

  const header = "%PDF-1.4\n";
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n";
  const obj4 =
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica " +
    "/Encoding /WinAnsiEncoding >>\nendobj\n";
  const obj5 =
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, "latin1")} >>\n` +
    `stream\n${content}endstream\nendobj\n`;

  const objects = [obj1, obj2, obj3, obj4, obj5];

  let offset = Buffer.byteLength(header, "latin1");
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(offset);
    offset += Buffer.byteLength(obj, "latin1");
  }
  const xrefStart = offset;

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(header + objects.join("") + xref + trailer, "latin1");
}

/** Opens the generated PDF with mupdf and verifies page count + visible text. */
async function selfCheck(bytes: Buffer): Promise<boolean> {
  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const pageCount = doc.countPages();
    if (pageCount !== 1) {
      console.error(`FAIL: expected 1 page, got ${pageCount}`);
      return false;
    }
    const page = doc.loadPage(0);
    const text = page.toStructuredText().asText();
    if (!text.includes("KASI BANK")) {
      console.error("FAIL: extracted page text does not contain 'KASI BANK'");
      console.error(text);
      return false;
    }
    console.log("OK: generated PDF has 1 page and contains visible text 'KASI BANK'");
    return true;
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function main(): Promise<void> {
  const outArg = process.argv[2];
  if (!outArg) {
    console.error("usage: npx tsx examples/claude-agent/generate-statement.ts <output.pdf>");
    process.exit(1);
  }
  const outPath = resolve(outArg);

  const lines = buildLines();
  const pdf = buildPdf(lines);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, pdf);
  console.log(`wrote ${pdf.length} bytes to ${outPath}`);

  const ok = await selfCheck(pdf);
  if (!ok) process.exit(1);
}

main();

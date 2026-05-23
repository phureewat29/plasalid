type Mupdf = typeof import("mupdf");
let mupdfPromise: Promise<Mupdf> | null = null;

function getMupdf(): Promise<Mupdf> {
  if (!mupdfPromise) mupdfPromise = import("mupdf");
  return mupdfPromise;
}

/**
 * 150 DPI keeps statement numerals readable to a VL model without blowing
 * up the token bill on a dense page.
 */
const DEFAULT_DPI = 150;

export async function rasterizePage(
  pdfBytes: Buffer,
  opts: { dpi?: number } = {},
): Promise<{ bytes: Buffer; mime: "image/png" }> {
  const mupdf = await getMupdf();
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const scale = dpi / 72;

  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  try {
    const page = doc.loadPage(0);
    try {
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
      );
      try {
        const png = pixmap.asPNG();
        return { bytes: Buffer.from(png), mime: "image/png" };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

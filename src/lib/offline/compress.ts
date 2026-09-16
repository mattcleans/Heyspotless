"use client";

/**
 * Shrink a photo before it is queued.
 *
 * Done BEFORE the durable write, not after, and for two reasons that both
 * matter more than they sound:
 *
 *   QUOTA. A modern phone camera produces about 4MB a shot. Twenty-two of
 *   those on a 4bd/4ba move-out is ninety megabytes sitting in IndexedDB,
 *   which is where a browser starts evicting things — and the thing it would
 *   evict is the photos.
 *
 *   UPLOAD. The connection this has to survive is a weak one inside somebody's
 *   house. A 300KB file gets through a signal a 4MB file does not, and the
 *   difference is whether her queue drains before she drives away.
 *
 * 1600px on the long edge is comfortably enough to show a clean room or
 * evidence a worktop was wiped. It is not enough to read a document left on a
 * side table, which is a feature rather than a limitation.
 */

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.8;

/**
 * Returns the original untouched if anything goes wrong.
 *
 * A failed resize must never mean a lost photo. An oversized upload is a slow
 * problem; a discarded one is the problem this whole subsystem exists to
 * prevent.
 */
export async function compress(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));

    // Already small enough. Re-encoding would cost quality for nothing.
    if (scale >= 1) {
      bitmap.close();
      return file;
    }

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return file;
    }

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );

    // If the resize somehow made it bigger, keep the original.
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

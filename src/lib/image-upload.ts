/**
 * Compress a user-supplied image File into a Blob suitable for storage
 * in the Dexie attachments table (see src/db/db.ts).
 *
 * Why Blob and not a data URL string anymore:
 *   - Base64 inline payloads were bloating IndexedDB by ~33% and risked
 *     hitting the per-key size limit on indexed fields.
 *   - The TipTap NodeView now resolves `attachment:<id>` references to
 *     `blob:` URLs at render time, so the editor never sees base64 strings
 *     for new images — it sees stable attachment references.
 *
 * Fallback policy (preserves user data on every failure path):
 *   - `FileReader.onerror` -> reject.
 *   - `Image.onerror` (corrupt / unsupported file) -> resolve the original
 *     File unchanged so the bytes still end up in the note.
 *   - `canvas.getContext('2d') === null` (e.g. environment without 2D
 *     canvas) -> resolve the original File.
 *   - `canvas.toBlob` callback receives null (tainted canvas, OOM) ->
 *     resolve the original File.
 *
 * No size target is set on the fallback File; the original is whatever the
 * user dropped. The compression path targets at most 1600px on the long
 * edge and writes JPEG @ 0.82 quality (or PNG when the source is already
 * a small PNG, to preserve transparency).
 */
export const compressImage = (file: File): Promise<Blob> => {
  return new Promise<Blob>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const MAX_WIDTH = 1600;
        const MAX_HEIGHT = 1600;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          // Canvas unavailable -> preserve the original File bytes.
          resolve(file);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);

        // Keep PNG transparently when the source is small PNG (likely an
        // icon or transparent sticker); otherwise transcode to JPEG to
        // capitalize on its much better compression for photos.
        const targetType =
          file.type === 'image/png' && file.size < 300_000
            ? 'image/png'
            : 'image/jpeg';
        const quality = targetType === 'image/jpeg' ? 0.82 : 1;

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              // Tainted canvas, OOM, or other toBlob failure -> preserve
              // the original File so the user keeps their bytes.
              resolve(file);
              return;
            }
            resolve(blob);
          },
          targetType,
          quality,
        );
      };
      img.onerror = () => {
        // Image decode failed; preserve the original File.
        resolve(file);
      };
      img.src = reader.result as string;
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
};

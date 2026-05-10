// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

const imageExtensions = ['.jpeg', '.jpg', '.png', '.webp'];

/**
 * Checks if a given field name corresponds to an image file extension.
 *
 * @param {string} fieldName The name of the field to check.
 * @returns {boolean} True if the field is an image, false otherwise.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function isImageField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return imageExtensions.some((ext) => lower.endsWith(ext));
}

/**
 * Converts a value to a generic display string.
 *
 * @param {unknown} value The value to display.
 * @returns {string} The string representation of the value.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Formats a size in bytes to a human-readable string (B, KB, MB).
 *
 * @param {number} bytes The size in bytes.
 * @returns {string} The formatted size string.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Escapes HTML characters in a string to prevent XSS.
 *
 * @param {string} str The string to escape.
 * @returns {string} The HTML-escaped string.
 *
 * @author Alexandre-Gatien Bienfet
 */
export function escapeHTML(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// @author Alexandre-Gatien Bienfet
// @date 2026-03-31

/**
 * Performs an API call to the SimpleDBMS backend.
 *
 * @param {string} endpoint The API endpoint URL.
 * @param {string} [method='GET'] The HTTP method to use (e.g. 'GET', 'POST').
 * @param {unknown} [body] Optional JSON body to send with the request.
 * @returns {Promise<{ error?: string; [key: string]: unknown }>} The parsed JSON data.
 *
 * @author Alexandre-Gatien Bienfet
 */
export async function apiCall(endpoint: string, method: string = 'GET', body?: unknown) {
  const options: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(endpoint, options);
  const data = (await response.json()) as { error?: string; [key: string]: unknown };
  if (!response.ok) throw new Error(data['error'] ?? 'API Error');
  return data;
}

// author: Alexandre-Gatien Bienfet
// date: 2026-02-23
//
// API call helper for the SimpleDBMS webclient

export async function apiCall(endpoint: string, method: string = 'GET', body?: unknown) {
  const options: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(endpoint, options);
  const data = (await response.json()) as { error?: string; [key: string]: unknown };
  if (!response.ok) throw new Error(data['error'] ?? 'API Error');
  return data;
}

type ApiOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | Record<string, unknown>;
};

export async function api<T = Record<string, unknown>>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  const { body, ...requestOptions } = opts;
  const init: RequestInit = {
    ...requestOptions,
    headers,
  };

  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  } else {
    init.body = body;
  }

  const res = await fetch(path, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }

  if (!res.ok) {
    const message = json && typeof json === 'object' && 'error' in json
      ? String(json.error)
      : `HTTP ${res.status}`;
    throw new Error(message);
  }

  return json as T;
}

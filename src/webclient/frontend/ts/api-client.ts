type ApiOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | Record<string, unknown>;
};

function isJsonBody(body: unknown): body is Record<string, unknown> {
  return (
    body !== null &&
    typeof body === 'object' &&
    (Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null)
  );
}

export async function api<T = Record<string, unknown>>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  const { body, ...requestOptions } = opts;
  const init: RequestInit = {
    ...requestOptions,
    headers,
  };

  if (isJsonBody(body)) {
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
    if (res.ok) throw new Error('The server returned an invalid JSON response.');
    json = { error: text };
  }

  if (!res.ok) {
    const message =
      json && typeof json === 'object' && 'error' in json && typeof json.error === 'string' && json.error.trim()
        ? json.error
        : `HTTP ${res.status}`;
    throw new Error(message);
  }

  return json as T;
}

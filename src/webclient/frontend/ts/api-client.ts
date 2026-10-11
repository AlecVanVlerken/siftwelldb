type ApiOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | Record<string, unknown>;
};

export type DisconnectedConnection = { connected: false; filepath: string | null };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly affectedIds?: Array<string | number>,
    readonly connection?: DisconnectedConnection,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

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
    const affectedIds =
      json &&
      typeof json === 'object' &&
      'affectedIds' in json &&
      Array.isArray(json.affectedIds) &&
      json.affectedIds.every(
        (id: unknown): id is string | number =>
          typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)),
      )
        ? json.affectedIds
        : undefined;
    const connection: DisconnectedConnection | undefined =
      json &&
      typeof json === 'object' &&
      'connected' in json &&
      json.connected === false &&
      'filepath' in json &&
      (typeof json.filepath === 'string' || json.filepath === null)
        ? { connected: false, filepath: json.filepath }
        : undefined;
    throw new ApiError(message, affectedIds, connection);
  }

  return json as T;
}

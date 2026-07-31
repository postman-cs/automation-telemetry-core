import { createHash } from 'node:crypto';

export interface CassetteRequest {
  key: string;
  requestQuery: string;
  requestBodySha256?: string;
}

export interface CassetteInteraction extends CassetteRequest {
  status: number;
  statusText?: string;
  body: string;
  responseHeaders: Record<string, string>;
  repeatLast?: boolean;
}

export interface Cassette {
  version: 2;
  recordedAt?: string;
  interactions: CassetteInteraction[];
}

export const CASSETTE_MINTED_TOKEN = 'cassette-access-token';

const SENSITIVE_RESPONSE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-access-token',
  'x-api-key'
]);

export function createEmptyCassette(): Cassette {
  return { version: 2, interactions: [] };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function bodyDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const bytes = typeof value === 'string' ? value : stableJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

function appendQueryValue(params: URLSearchParams, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) appendQueryValue(params, name, entry);
    return;
  }
  if (value === undefined) return;
  if (value !== null && typeof value === 'object') {
    params.append(name, stableJson(value));
    return;
  }
  params.append(name, value === null ? 'null' : String(value));
}

function canonicalQuery(
  url: URL,
  envelopeQuery?: Record<string, unknown>
): string {
  const params = new URLSearchParams(url.searchParams);
  for (const [name, value] of Object.entries(envelopeQuery ?? {})) {
    appendQueryValue(params, name, value);
  }
  params.sort();
  return params.toString();
}

function requestKey(
  prefix: string,
  query: string,
  requestBodySha256?: string
): string {
  return `${prefix}${query ? `?${query}` : ''}${
    requestBodySha256 ? ` #body-sha256=${requestBodySha256}` : ''
  }`;
}

export function cassetteRequest(
  url: string,
  method: string,
  requestBody?: string
): CassetteRequest {
  const parsedUrl = new URL(url);
  if (/\/ws\/proxy$/.test(parsedUrl.pathname) && requestBody) {
    try {
      const envelope = JSON.parse(requestBody) as {
        service?: unknown;
        method?: unknown;
        path?: unknown;
        query?: unknown;
        body?: unknown;
      };
      const proxiedPath = new URL(String(envelope.path ?? ''), 'https://cassette.invalid');
      const envelopeQuery =
        envelope.query && typeof envelope.query === 'object' && !Array.isArray(envelope.query)
          ? (envelope.query as Record<string, unknown>)
          : undefined;
      const requestQuery = canonicalQuery(proxiedPath, envelopeQuery);
      const requestBodySha256 = bodyDigest(envelope.body);
      const prefix = `proxy:${String(envelope.service ?? '')} ${String(
        envelope.method ?? 'get'
      ).toUpperCase()} ${proxiedPath.pathname}`;
      return {
        key: requestKey(prefix, requestQuery, requestBodySha256),
        requestQuery,
        ...(requestBodySha256 ? { requestBodySha256 } : {})
      };
    } catch {
      // Invalid envelopes remain distinguishable through the direct request digest.
    }
  }

  const requestQuery = canonicalQuery(parsedUrl);
  const requestBodySha256 = bodyDigest(requestBody);
  const prefix = `${method.toUpperCase()} ${parsedUrl.origin}${parsedUrl.pathname}`;
  return {
    key: requestKey(prefix, requestQuery, requestBodySha256),
    requestQuery,
    ...(requestBodySha256 ? { requestBodySha256 } : {})
  };
}

export function interactionKey(
  url: string,
  method: string,
  requestBody?: string
): string {
  return cassetteRequest(url, method, requestBody).key;
}

function isMintKey(key: string): boolean {
  return /^POST https?:\/\/[^ ]+\/service-account-tokens(?:[? ]|$)/.test(key);
}

function redactResponseBody(
  key: string,
  body: string,
  mask: (value: string) => string
): string {
  if (isMintKey(key)) {
    return JSON.stringify({ access_token: CASSETTE_MINTED_TOKEN });
  }
  return mask(body);
}

function responseHeaders(
  headers: Headers,
  mask: (value: string) => string
): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name.toLowerCase(),
        SENSITIVE_RESPONSE_HEADERS.has(name.toLowerCase()) ? '[REDACTED]' : mask(value)
      ])
  );
}

async function requestBodyText(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string | undefined> {
  const body = init?.body;
  if (body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString();
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString();
  }
  if (body !== undefined) {
    throw new TypeError('Cassette transport cannot key a streaming request body');
  }
  if (input instanceof Request && input.body !== null) {
    return input.clone().text();
  }
  return undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

export function createRecordingFetch(
  inner: typeof fetch,
  cassette: Cassette,
  mask: (value: string) => string = (value) => value
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = cassetteRequest(
      requestUrl(input),
      requestMethod(input, init),
      await requestBodyText(input, init)
    );
    const response = await inner(input, init);
    const body = await response.clone().text().catch(() => '');
    cassette.interactions.push({
      ...request,
      status: response.status,
      statusText: response.statusText,
      body: redactResponseBody(request.key, body, mask),
      responseHeaders: responseHeaders(response.headers, mask)
    });
    cassette.recordedAt = new Date().toISOString();
    return response;
  }) as typeof fetch;
}

function validateCassette(cassette: Cassette): void {
  if (cassette.version !== 2) {
    throw new Error(`Unsupported cassette version ${String(cassette.version)}; expected version 2`);
  }
}

export function createReplayFetch(cassette: Cassette): typeof fetch {
  validateCassette(cassette);
  const queues = new Map<string, CassetteInteraction[]>();
  for (const interaction of cassette.interactions) {
    const queue = queues.get(interaction.key) ?? [];
    queue.push(interaction);
    queues.set(interaction.key, queue);
  }
  const repeatLast = new Map<string, CassetteInteraction>();

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = cassetteRequest(
      requestUrl(input),
      requestMethod(input, init),
      await requestBodyText(input, init)
    );
    const queue = queues.get(request.key);
    let interaction = queue?.shift();
    if (interaction) {
      if (interaction.repeatLast) repeatLast.set(request.key, interaction);
      else repeatLast.delete(request.key);
    }
    interaction ??= repeatLast.get(request.key);
    if (!interaction) {
      const recordedKeys = [...queues.keys()].join('\n');
      if (queue) {
        throw new Error(
          `Cassette response queue exhausted for "${request.key}". ` +
            'Add another interaction or declare repeatLast on the final fixture entry.'
        );
      }
      throw new Error(
        `Cassette has no recorded response for "${request.key}". Recorded keys:\n${recordedKeys}`
      );
    }
    const nullBody =
      interaction.status === 204 || interaction.status === 205 || interaction.status === 304;
    return new Response(nullBody ? null : interaction.body, {
      status: interaction.status,
      statusText: interaction.statusText,
      headers: interaction.responseHeaders
    });
  }) as typeof fetch;
}

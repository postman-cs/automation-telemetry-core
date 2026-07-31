export const REDACTED = '[REDACTED]';

export type HeaderBag = Array<[string, string]> | Headers | Record<string, string>;

export interface HttpErrorInit {
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestHeaders?: HeaderBag;
  responseBody?: string;
  secretValues?: unknown;
  bodyLimit?: number;
  oneLine?: boolean;
  message?: string;
}

export type HttpErrorResponseInit = Omit<
  HttpErrorInit,
  'responseBody' | 'status' | 'statusText'
> & {
  responseBody?: string;
};

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-access-token',
  'x-api-key'
]);

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value !== 'string' &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  );
}

function appendStringSecret(value: string, results: string[]): void {
  const normalized = value.trim();
  if (!normalized) return;
  results.push(normalized);
  try {
    const encoded = encodeURIComponent(normalized);
    if (encoded !== normalized) results.push(encoded);
  } catch {
    // The raw value still protects malformed surrogate pairs.
  }
  try {
    const url = new URL('http://localhost/');
    url.password = normalized;
    if (url.password && url.password !== normalized) results.push(url.password);
  } catch {
    // Other registered variants remain usable when URL encoding rejects a value.
  }
}

function appendSecretValues(value: unknown, results: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    appendStringSecret(value, results);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    appendStringSecret(String(value), results);
    return;
  }
  if (Array.isArray(value) || isIterable(value)) {
    for (const entry of value) appendSecretValues(entry, results);
  }
}

export function normalizeSecretValues(secretValues: unknown): string[] {
  const values: string[] = [];
  appendSecretValues(secretValues, values);
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

export function redactSecrets(
  input: string,
  secretValues: unknown,
  replacement = REDACTED
): string {
  let output = String(input ?? '');
  for (const secret of normalizeSecretValues(secretValues)) {
    output = output.split(secret).join(replacement);
  }
  return output;
}

export function toOneLine(value: unknown): string {
  const source = String(value ?? '');
  let output = '';
  let pendingSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) {
      output += ' ';
      pendingSpace = false;
    }
    output += source.charAt(index);
  }
  return output;
}

function headerEntries(headers: HeaderBag): Array<[string, string]> {
  if (headers instanceof Headers) return Array.from(headers.entries());
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [name, String(value)]);
  }
  return Object.entries(headers).map(([name, value]) => [name, String(value)]);
}

export function sanitizeHeaders(
  headers: HeaderBag | undefined,
  secretValues: unknown
): Record<string, string> {
  if (!headers) return {};
  const sanitized: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = SENSITIVE_HEADER_NAMES.has(normalizedName)
      ? REDACTED
      : redactSecrets(value, secretValues);
  }
  return sanitized;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated]`;
}

function buildMessage(init: HttpErrorInit): string {
  if (init.message !== undefined) return init.message;
  const format = init.oneLine ? toOneLine : String;
  const method = String(init.method || 'GET').toUpperCase();
  const status = `${init.status}${init.statusText ? ` ${init.statusText}` : ''}`;
  const url = format(redactSecrets(init.url, init.secretValues));
  const body = format(
    truncate(
      redactSecrets(init.responseBody || '', init.secretValues),
      Math.max(0, init.bodyLimit ?? 800)
    )
  );
  return body
    ? `${method} ${url} failed: ${status} - ${body}`
    : `${method} ${url} failed: ${status}`;
}

export class HttpError extends Error {
  readonly method: string;
  readonly requestHeaders: HeaderBag | undefined;
  readonly responseBody: string;
  readonly secretValues: unknown;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor(init: HttpErrorInit);
  constructor(message: string, status: number);
  constructor(initOrMessage: HttpErrorInit | string, legacyStatus?: number) {
    const init: HttpErrorInit =
      typeof initOrMessage === 'string'
        ? {
            method: '',
            url: '',
            status: legacyStatus ?? 0,
            statusText: '',
            message: initOrMessage
          }
        : initOrMessage;
    super(buildMessage(init));
    this.name = 'HttpError';
    this.method = String(init.method || 'GET').toUpperCase();
    this.requestHeaders = init.requestHeaders;
    this.responseBody = init.responseBody || '';
    this.secretValues = init.secretValues;
    this.status = init.status;
    this.statusText = init.statusText;
    this.url = init.url;
  }

  static async fromResponse(
    response: Response,
    init: HttpErrorResponseInit
  ): Promise<HttpError> {
    const responseBody = init.responseBody ?? (await response.text().catch(() => ''));
    return new HttpError({
      ...init,
      responseBody,
      status: response.status,
      statusText: response.statusText
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      method: this.method,
      name: this.name,
      requestHeaders: sanitizeHeaders(this.requestHeaders, this.secretValues),
      responseBody: redactSecrets(this.responseBody, this.secretValues),
      status: this.status,
      statusText: this.statusText,
      url: redactSecrets(this.url, this.secretValues)
    };
  }
}

import { HttpError, redactSecrets } from './http-error.js';
import {
  fullJitterDelayMs,
  isRetryableGatewayFailure,
  parseRetryAfterMs
} from './retry.js';

export const DEFAULT_POSTMAN_BIFROST_BASE_URL =
  'https://bifrost-premium-https-v4.gw.postman.com';

export type GatewayMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type GatewayRetryMode = 'safe' | 'rate-limit' | 'none';
export type GatewayFallbackMode = 'auto' | 'none';

export interface GatewayRetryEvent {
  class: 'http' | 'inner' | 'transport' | 'auth' | 'fallback' | 'poll';
  status?: number;
  attempt: number;
  delay: number;
}

export interface GatewayRequest {
  service: string;
  method: GatewayMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  retry?: GatewayRetryMode;
  fallback?: GatewayFallbackMode;
  maxRetries?: number;
}

export interface GatewayRequestOptions {
  retryTransient?: boolean;
}

export interface GatewayDirectRequest {
  path: string;
  method?: GatewayMethod;
  body?: unknown;
  headers?: Record<string, string>;
  retry?: GatewayRetryMode;
  maxRetries?: number;
}

export interface GatewayTokenProvider {
  current(): string;
  canRefresh(): boolean;
  refresh(): Promise<unknown>;
}

export interface GatewayAppVersionProvider {
  resolve?: () => Promise<string | undefined>;
  get?: () => Promise<string | undefined>;
}

export type GatewaySecretMasker = (input: string) => string;

export interface AccessTokenGatewayClientOptions {
  tokenProvider: GatewayTokenProvider;
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  secretMasker?: GatewaySecretMasker;
  maxRetries?: number;
  fallbackBaseUrl?: string;
  fallbackOn?: 'error' | 'transient';
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  jitterRounding?: 'floor' | 'round';
  requestTimeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  appVersionProvider?: GatewayAppVersionProvider;
  onRetry?: (event: GatewayRetryEvent) => void;
  onRetryEvent?: (event: GatewayRetryEvent) => void;
  refreshEmptyToken?: boolean;
  refreshOnInnerAuthError?: boolean;
  classifyInnerAuthError?: boolean;
  defaultInnerErrorStatus?: number;
  includeFallbackStatusInRetryEvent?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface EffectiveResponse {
  response: Response;
  body: string;
  innerStatus?: number;
}

function isExpiredAuthError(status: number, body: string): boolean {
  return (
    status === 401 ||
    body.includes('UNAUTHENTICATED') ||
    body.includes('authenticationError')
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export class AccessTokenGatewayClient {
  private readonly tokenProvider: GatewayTokenProvider;
  private readonly bifrostBaseUrl: string;
  private teamId: string;
  private orgMode: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: GatewaySecretMasker;
  private readonly maxRetries: number;
  private readonly fallbackBaseUrl?: string;
  private readonly fallbackOn: 'error' | 'transient';
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly jitterRounding: 'floor' | 'round';
  private readonly requestTimeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly randomImpl: () => number;
  private readonly appVersionProvider?: GatewayAppVersionProvider;
  private readonly onRetry?: (event: GatewayRetryEvent) => void;
  private readonly onRetryEvent?: (event: GatewayRetryEvent) => void;
  private readonly refreshEmptyToken: boolean;
  private readonly refreshOnInnerAuthError: boolean;
  private readonly classifyInnerAuthError: boolean;
  private readonly defaultInnerErrorStatus: number;
  private readonly includeFallbackStatusInRetryEvent: boolean;

  constructor(options: AccessTokenGatewayClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.bifrostBaseUrl = normalizedBaseUrl(
      String(options.bifrostBaseUrl || DEFAULT_POSTMAN_BIFROST_BASE_URL)
    );
    this.teamId = String(options.teamId || '').trim();
    this.orgMode = options.orgMode ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ??
      ((input) => redactSecrets(input, [this.tokenProvider.current()]));
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    const fallbackDisabled =
      (options.env ?? process.env).POSTMAN_ITEM_CREATE_FALLBACK === 'off';
    this.fallbackBaseUrl =
      fallbackDisabled || !options.fallbackBaseUrl
        ? undefined
        : normalizedBaseUrl(options.fallbackBaseUrl);
    this.fallbackOn = options.fallbackOn ?? 'error';
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 400);
    this.retryMaxDelayMs = Math.max(0, options.retryMaxDelayMs ?? 5_000);
    this.jitterRounding = options.jitterRounding ?? 'floor';
    this.requestTimeoutMs = Math.max(0, options.requestTimeoutMs ?? 30_000);
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.randomImpl = options.randomImpl ?? Math.random;
    this.appVersionProvider = options.appVersionProvider;
    this.onRetry = options.onRetry;
    this.onRetryEvent = options.onRetryEvent;
    this.refreshEmptyToken = options.refreshEmptyToken ?? true;
    this.refreshOnInnerAuthError = options.refreshOnInnerAuthError ?? false;
    this.classifyInnerAuthError = options.classifyInnerAuthError ?? false;
    this.defaultInnerErrorStatus = options.defaultInnerErrorStatus ?? 502;
    this.includeFallbackStatusInRetryEvent =
      options.includeFallbackStatusInRetryEvent ?? true;
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.teamId = String(teamId || '').trim();
    this.orgMode = orgMode;
  }

  private async resolveAppVersion(): Promise<string | undefined> {
    if (this.appVersionProvider?.resolve) return this.appVersionProvider.resolve();
    if (this.appVersionProvider?.get) return this.appVersionProvider.get();
    return undefined;
  }

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(extra ?? {})
    };
    headers['x-access-token'] = this.tokenProvider.current();
    if (this.teamId && this.orgMode) headers['x-entity-team-id'] = this.teamId;
    const appVersion = await this.resolveAppVersion();
    if (appVersion) headers['x-app-version'] = appVersion;
    return headers;
  }

  private errorHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(extra ?? {}),
      'x-access-token': this.tokenProvider.current(),
      ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
    };
  }

  private async send(request: GatewayRequest, baseUrl = this.bifrostBaseUrl): Promise<Response> {
    return this.fetchWithDeadline(`${baseUrl}/ws/proxy`, {
      method: 'POST',
      headers: await this.buildHeaders(request.headers),
      body: JSON.stringify({
        service: request.service,
        method: request.method,
        path: request.path,
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {})
      })
    });
  }

  private async sendDirect(request: GatewayDirectRequest): Promise<Response> {
    const method = request.method ?? 'get';
    return this.fetchWithDeadline(`${this.bifrostBaseUrl}${request.path}`, {
      method: method.toUpperCase(),
      headers: await this.buildHeaders(request.headers),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
    });
  }

  private async fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private detectInnerStatus(body: string): number | undefined {
    const trimmed = body.trim();
    if (!trimmed) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    const envelope = asRecord(parsed);
    if (!envelope) return undefined;
    const error = envelope.error;
    const errorRecord = asRecord(error);
    const source = errorRecord ?? envelope;
    const status =
      numericStatus(source.status) ??
      numericStatus(source.statusCode) ??
      numericStatus(envelope.status) ??
      numericStatus(envelope.statusCode);
    const hasError =
      (error !== undefined &&
        error !== null &&
        !(errorRecord && Object.keys(errorRecord).length === 0)) ||
      source.success === false ||
      envelope.success === false ||
      (status !== undefined && status >= 400);
    if (!hasError) return undefined;
    if (status !== undefined && status >= 400) return status;
    if (this.classifyInnerAuthError && isExpiredAuthError(0, body)) return 401;
    return this.defaultInnerErrorStatus;
  }

  private async inspect(response: Response): Promise<EffectiveResponse> {
    const body = await response.text().catch(() => '');
    return {
      response,
      body,
      ...(response.ok
        ? { innerStatus: this.detectInnerStatus(body) }
        : {})
    };
  }

  private resolveRetryMode(
    request: GatewayRequest,
    options: GatewayRequestOptions
  ): GatewayRetryMode {
    if (request.retry) return request.retry;
    if (options.retryTransient !== undefined) {
      return options.retryTransient ? 'safe' : 'none';
    }
    if (request.maxRetries !== undefined) {
      return request.maxRetries > 0 ? 'safe' : 'none';
    }
    return request.method === 'get' ? 'safe' : 'none';
  }

  private shouldRetry(mode: GatewayRetryMode, status: number, body: string): boolean {
    if (mode === 'rate-limit') return status === 429;
    return mode === 'safe' && isRetryableGatewayFailure(status, body);
  }

  private retryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(this.retryMaxDelayMs, retryAfterMs);
    return fullJitterDelayMs(
      attempt,
      this.retryBaseDelayMs,
      this.retryMaxDelayMs,
      this.randomImpl,
      this.jitterRounding
    );
  }

  private emitRetryEvent(event: GatewayRetryEvent): void {
    this.onRetryEvent?.(event);
    if (this.onRetry && this.onRetry !== this.onRetryEvent) this.onRetry(event);
  }

  private fallbackEligible(
    request: GatewayRequest,
    retryMode: GatewayRetryMode,
    transient: boolean
  ): boolean {
    if (!this.fallbackBaseUrl || request.fallback === 'none') return false;
    if (retryMode !== 'safe' && request.fallback !== 'auto') return false;
    return this.fallbackOn === 'error' || transient;
  }

  private async attemptFallback(
    request: GatewayRequest,
    retryMode: GatewayRetryMode,
    transient: boolean,
    status?: number
  ): Promise<Response | null> {
    if (!this.fallbackEligible(request, retryMode, transient)) return null;
    this.emitRetryEvent({
      class: 'fallback',
      ...(this.includeFallbackStatusInRetryEvent && status !== undefined ? { status } : {}),
      attempt: 1,
      delay: 0
    });
    let inspected: EffectiveResponse;
    try {
      inspected = await this.inspect(await this.send(request, this.fallbackBaseUrl));
    } catch {
      return null;
    }
    const effectiveStatus = inspected.innerStatus ?? inspected.response.status;
    if (inspected.response.ok && inspected.innerStatus === undefined) {
      return this.rebuildResponse(inspected.response, inspected.body);
    }
    if (isRetryableGatewayFailure(effectiveStatus, inspected.body)) return null;
    if (inspected.innerStatus !== undefined) {
      throw this.toInnerHttpError(request, inspected.innerStatus, inspected.body);
    }
    throw this.toHttpError(request, inspected.response, inspected.body);
  }

  async request(
    request: GatewayRequest,
    options: GatewayRequestOptions = {}
  ): Promise<Response> {
    if (
      this.refreshEmptyToken &&
      !this.tokenProvider.current() &&
      this.tokenProvider.canRefresh()
    ) {
      await this.tokenProvider.refresh();
    }
    const retryMode = this.resolveRetryMode(request, options);
    const maxRetries = Math.max(0, request.maxRetries ?? this.maxRetries);
    let attempt = 0;
    let authRefreshed = false;

    for (;;) {
      let inspected: EffectiveResponse;
      try {
        inspected = await this.inspect(await this.send(request));
      } catch (error) {
        if (retryMode === 'safe' && attempt < maxRetries) {
          const delay = this.retryDelayMs(attempt);
          attempt += 1;
          this.emitRetryEvent({ class: 'transport', attempt, delay });
          await this.sleepImpl(delay);
          continue;
        }
        const fallback = await this.attemptFallback(request, retryMode, true);
        if (fallback) return fallback;
        throw error;
      }

      const effectiveStatus = inspected.innerStatus ?? inspected.response.status;
      if (inspected.response.ok && inspected.innerStatus === undefined) {
        return this.rebuildResponse(inspected.response, inspected.body);
      }

      const authFailure = isExpiredAuthError(effectiveStatus, inspected.body);
      const refreshAllowed =
        inspected.innerStatus === undefined || this.refreshOnInnerAuthError;
      if (
        !authRefreshed &&
        authFailure &&
        refreshAllowed &&
        this.tokenProvider.canRefresh()
      ) {
        authRefreshed = true;
        this.emitRetryEvent({
          class: 'auth',
          status: effectiveStatus,
          attempt: 1,
          delay: 0
        });
        await this.tokenProvider.refresh();
        continue;
      }

      const transient = isRetryableGatewayFailure(effectiveStatus, inspected.body);
      if (
        this.shouldRetry(retryMode, effectiveStatus, inspected.body) &&
        attempt < maxRetries
      ) {
        const retryAfterMs =
          inspected.innerStatus === undefined
            ? parseRetryAfterMs(inspected.response.headers.get('retry-after'))
            : undefined;
        const delay = this.retryDelayMs(attempt, retryAfterMs);
        attempt += 1;
        this.emitRetryEvent({
          class: inspected.innerStatus === undefined ? 'http' : 'inner',
          status: effectiveStatus,
          attempt,
          delay
        });
        await this.sleepImpl(delay);
        continue;
      }

      const fallback = await this.attemptFallback(
        request,
        retryMode,
        transient,
        effectiveStatus
      );
      if (fallback) return fallback;
      if (inspected.innerStatus !== undefined) {
        throw this.toInnerHttpError(request, inspected.innerStatus, inspected.body);
      }
      throw this.toHttpError(request, inspected.response, inspected.body);
    }
  }

  async requestJson<T = Record<string, unknown>>(
    request: GatewayRequest,
    options: GatewayRequestOptions = {}
  ): Promise<T | null> {
    const response = await this.request(request, options);
    return this.responseJson<T>(response);
  }

  async requestDirectJson<T = Record<string, unknown>>(
    requestOrPath: GatewayDirectRequest | string
  ): Promise<T | null> {
    const request: GatewayDirectRequest =
      typeof requestOrPath === 'string'
        ? { path: requestOrPath, method: 'get' }
        : requestOrPath;
    if (!request.path.startsWith('/')) {
      throw new Error(`Direct Bifrost path must start with '/': ${request.path}`);
    }
    if (
      this.refreshEmptyToken &&
      !this.tokenProvider.current() &&
      this.tokenProvider.canRefresh()
    ) {
      await this.tokenProvider.refresh();
    }
    const method = request.method ?? 'get';
    const retryMode = request.retry ?? (method === 'get' ? 'safe' : 'none');
    const maxRetries = Math.max(0, request.maxRetries ?? this.maxRetries);
    let attempt = 0;
    let authRefreshed = false;

    for (;;) {
      let response: Response;
      try {
        response = await this.sendDirect(request);
      } catch (error) {
        if (retryMode === 'safe' && attempt < maxRetries) {
          const delay = this.retryDelayMs(attempt);
          attempt += 1;
          this.emitRetryEvent({ class: 'transport', attempt, delay });
          await this.sleepImpl(delay);
          continue;
        }
        throw error;
      }
      const body = await response.text().catch(() => '');
      if (response.ok) return this.textJson<T>(body);
      if (
        !authRefreshed &&
        isExpiredAuthError(response.status, body) &&
        this.tokenProvider.canRefresh()
      ) {
        authRefreshed = true;
        this.emitRetryEvent({
          class: 'auth',
          status: response.status,
          attempt: 1,
          delay: 0
        });
        await this.tokenProvider.refresh();
        continue;
      }
      if (
        this.shouldRetry(retryMode, response.status, body) &&
        attempt < maxRetries
      ) {
        const delay = this.retryDelayMs(
          attempt,
          parseRetryAfterMs(response.headers.get('retry-after'))
        );
        attempt += 1;
        this.emitRetryEvent({
          class: 'http',
          status: response.status,
          attempt,
          delay
        });
        await this.sleepImpl(delay);
        continue;
      }
      throw this.toDirectHttpError(request, response, body);
    }
  }

  private async responseJson<T>(response: Response): Promise<T | null> {
    return this.textJson<T>(await response.text().catch(() => ''));
  }

  private textJson<T>(text: string): T | null {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private rebuildResponse(response: Response, body: string): Response {
    const nullBody = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(nullBody ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  private toHttpError(request: GatewayRequest, response: Response, body: string): HttpError {
    return new HttpError({
      method: request.method.toUpperCase(),
      url: `${this.bifrostBaseUrl}/ws/proxy (${request.service}: ${request.method} ${request.path})`,
      status: response.status,
      statusText: response.statusText,
      requestHeaders: this.errorHeaders(request.headers),
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }

  private toInnerHttpError(request: GatewayRequest, status: number, body: string): HttpError {
    return new HttpError({
      method: request.method.toUpperCase(),
      url: `${this.bifrostBaseUrl}/ws/proxy (${request.service}: ${request.method} ${request.path}) [inner]`,
      status,
      statusText: 'Inner Error',
      requestHeaders: this.errorHeaders(request.headers),
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }

  private toDirectHttpError(
    request: GatewayDirectRequest,
    response: Response,
    body: string
  ): HttpError {
    return new HttpError({
      method: (request.method ?? 'get').toUpperCase(),
      url: `${this.bifrostBaseUrl}${request.path}`,
      status: response.status,
      statusText: response.statusText,
      requestHeaders: this.errorHeaders(request.headers),
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }
}

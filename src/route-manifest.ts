/**
 * WS4 route-manifest ratchet: fail-closed static route extraction and manifest
 * validation shared by the Postman Enterprise Automation Suite.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type RouteClassification = 'simulated' | 'live-only' | 'intentionally-unsimulated';

export const ROUTE_CLASSIFICATIONS: readonly RouteClassification[] = [
  'simulated',
  'live-only',
  'intentionally-unsimulated'
];

export interface RouteManifestRoute {
  id: string;
  service: string;
  method: string;
  path: string;
  classification: RouteClassification;
  reason?: string;
  cassettes?: string[];
}

export interface RouteManifest {
  schemaVersion: number;
  routes: RouteManifestRoute[];
}

export interface ExtractedRoute {
  /** Semantic key: `<service> <METHOD> <path>`. */
  id: string;
  service: string;
  method: string;
  path: string;
  /** `relative/file.ts:line` for every call site that produced this route. */
  sources: string[];
}

export interface CallSite {
  file: string;
  line: number;
  snippet: string;
  reason: string;
  /** Present when this call site was attributed to an extracted route. */
  routeId?: string;
}

export interface ExtractionResult {
  routes: ExtractedRoute[];
  /** Every attributed, explicitly allowed, or unattributed HTTP call site. */
  callSites: CallSite[];
  unattributed: CallSite[];
}

export interface AllowedPassthrough {
  file: string;
  urlExpression: string;
  reason: string;
}

export interface ProxyHelperConfig {
  files?: readonly string[];
  service?: string;
  serviceArg?: number;
  methodArg?: number;
  pathArg?: number;
  initArg?: number;
  defaultMethod?: string;
  /** Explicit reason for allowing a transport-internal call with dynamic args. */
  dynamicCallReason?: string;
}

export type ProxyHelper = string | ProxyHelperConfig | readonly ProxyHelperConfig[];

export interface ServiceAliasRoute {
  service: string;
  /** Required only when the URL expression itself does not expose a path. */
  path?: string;
}

export type ServiceAlias = string | ServiceAliasRoute;

export interface ExtractRoutesOptions {
  /** Absolute path to the package's `src/` tree. */
  sourceRoot: string;
  /**
   * Positional proxy helpers: helper name -> service the helper hardcodes into
   * the Bifrost envelope. Method is argument 0, path is argument 1.
   */
  proxyHelpers?: Readonly<Record<string, ProxyHelper>>;
  /**
   * Base-URL expression -> service label, for direct (non-envelope) fetches.
   * Keyed on the innermost identifier of the leading `${...}` expression, e.g.
   * `apiHost`, or on a member expression such as `this.observabilityBaseUrl`.
   */
  serviceAliases?: Readonly<Record<string, ServiceAlias>>;
  /** Identifiers treated as `fetch`. */
  fetchCallees?: readonly string[];
  /**
   * Expressions that resolve to a proxy-envelope carrier URL (for example
   * `this.bifrostProxyUrl`). A fetch to one of these is attributed by the
   * envelope literal it carries, not by its own URL, so it is not itself a route.
   */
  envelopeCarriers?: readonly string[];
  /**
   * Declared transport pass-throughs: a fetch whose URL is an opaque parameter
   * because the enclosing function is a fetch adapter, not a caller of a fixed
   * route. Matched on file + URL expression (not line, so ordinary edits do not
   * invalidate the escape). Each entry needs a reason, and anything not listed
   * still fails closed.
   */
  allowedPassthroughs?: readonly AllowedPassthrough[];
}

export interface ValidateRouteManifestOptions {
  /** Absolute package root; cassette paths resolve against it. */
  repoRoot: string;
  /** Defaults to `<repoRoot>/src`. */
  sourceRoot?: string;
  manifest: unknown;
  extraction?: ExtractionResult;
  proxyHelpers?: Readonly<Record<string, ProxyHelper>>;
  serviceAliases?: Readonly<Record<string, ServiceAlias>>;
  fetchCallees?: readonly string[];
  envelopeCarriers?: readonly string[];
  allowedPassthroughs?: readonly AllowedPassthrough[];
}

export interface RouteManifestValidationResult {
  ok: boolean;
  errors: string[];
  extractedRoutes: ExtractedRoute[];
}

export type ValidateRouteManifestResult = RouteManifestValidationResult;

const DEFAULT_FETCH_CALLEES = ['fetch', 'fetchFn', 'fetchImpl', 'fetcher'];
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/* -------------------------------------------------------------------------- */
/* source scanning                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Blank out comments while preserving byte offsets and newlines, so downstream
 * matches keep accurate line numbers and prose can never mint a phantom route.
 * Tracks strings, template literals (including `${}` nesting) and regex
 * literals; `/` is a regex start only when the previous significant token
 * cannot end an expression.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  let index = 0;
  let previousSignificant = '';

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === char) { index += 1; break; }
        index += 1;
      }
      previousSignificant = 'literal';
      continue;
    }
    if (char === '`') {
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === '$' && source[index + 1] === '{') {
          index += 2;
          // Scan the interpolation as code until its matching brace.
          let depth = 1;
          while (index < source.length && depth > 0) {
            const inner = source[index];
            if (inner === '{') depth += 1;
            else if (inner === '}') depth -= 1;
            else if (inner === '"' || inner === "'" || inner === '`') {
              const quote = inner;
              index += 1;
              while (index < source.length) {
                if (source[index] === '\\') { index += 2; continue; }
                if (source[index] === quote) break;
                index += 1;
              }
            } else if (inner === '/' && source[index + 1] === '/') {
              const end = source.indexOf('\n', index);
              blank(index, end === -1 ? source.length : end);
              index = end === -1 ? source.length : end;
              continue;
            }
            index += 1;
          }
          continue;
        }
        if (source[index] === '`') { index += 1; break; }
        index += 1;
      }
      previousSignificant = 'literal';
      continue;
    }
    if (char === '/' && canStartRegex(previousSignificant)) {
      let scan = index + 1;
      let inClass = false;
      let closed = false;
      while (scan < source.length) {
        const rc = source[scan];
        if (rc === '\\') { scan += 2; continue; }
        if (rc === '\n') break;
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) { closed = true; scan += 1; break; }
        scan += 1;
      }
      if (closed) {
        index = scan;
        previousSignificant = 'literal';
        continue;
      }
    }
    if (!/\s/.test(char)) {
      previousSignificant = char;
    }
    index += 1;
  }

  return out.join('');
}

function canStartRegex(previousSignificant: string): boolean {
  if (previousSignificant === '') return true;
  if (previousSignificant === 'literal') return false;
  return !/[\w$)\]]/.test(previousSignificant);
}

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.[cm]?[jt]sx?$/.test(entry) && !/\.d\.ts$/.test(entry)) files.push(full);
    }
  };
  walk(root);
  return files;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** Read a balanced argument list starting at the index of its `(`. */
function readArgs(source: string, openParen: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let index = openParen;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let literal = char;
      index += 1;
      while (index < source.length) {
        literal += source[index];
        if (source[index] === '\\') {
          literal += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (source[index] === quote) { index += 1; break; }
        index += 1;
      }
      current += literal;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      if (depth > 1) current += char;
      index += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
      current += char;
      index += 1;
      continue;
    }
    if (char === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  return args;
}

interface Binding {
  name: string;
  value: string;
  index: number;
}

/**
 * Collect `const NAME = '...'` / `const NAME = \`...\`` bindings with their
 * source offsets. Offsets matter: one file legitimately declares the same local
 * name in two functions (`const endpoint` for both the mint route and the
 * identity route), so resolution must pick the nearest preceding binding rather
 * than the last one in the file.
 */
function collectConstants(source: string): Binding[] {
  const bindings: Binding[] = [];
  const pattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    bindings.push({ name: match[1]!, value: match[2]!, index: match.index });
  }
  return bindings;
}

/** Nearest binding of `name` declared before `index`, else the first one after. */
function resolveBinding(bindings: Binding[], name: string, index: number): string | undefined {
  let best: Binding | undefined;
  for (const binding of bindings) {
    if (binding.name !== name) continue;
    if (binding.index < index) {
      if (!best || binding.index > best.index) best = binding;
    }
  }
  if (best) return best.value;
  return bindings.find((binding) => binding.name === name)?.value;
}

function unquote(literal: string): string {
  return literal.slice(1, -1);
}

function isQuoted(text: string): boolean {
  return /^(['"`]).*\1$/s.test(text.trim());
}

/* -------------------------------------------------------------------------- */
/* path + service normalization                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a route path for use as a stable manifest key:
 * - drop the query string;
 * - a segment-initial interpolation (preceded by `/`) becomes `{param}`, so
 *   variable naming differences cannot split one backend route into many keys;
 * - an interpolation that does not start a segment can only be a query or
 *   suffix fragment (e.g. `/discovered-services${query}` where `query` is a
 *   ternary yielding `?cursor=...`), so it and everything after it is dropped.
 *   The route stays visible to the diff under its shortened path rather than
 *   forking into a second phantom key per call site.
 */
export function normalizePath(raw: string): string {
  const withoutQuery = raw.split('?')[0] ?? '';
  let normalized = '';
  let index = 0;
  while (index < withoutQuery.length) {
    const open = withoutQuery.indexOf('${', index);
    if (open === -1) {
      normalized += withoutQuery.slice(index);
      break;
    }
    const close = withoutQuery.indexOf('}', open);
    if (close === -1) {
      normalized += withoutQuery.slice(index);
      break;
    }
    normalized += withoutQuery.slice(index, open);
    if (!normalized.endsWith('/')) {
      // Suffix/query interpolation: stop here.
      break;
    }
    normalized += '{param}';
    index = close + 1;
  }
  return normalized.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

/**
 * Name of the function enclosing `index`, used to scope service aliases when
 * two functions in one file take a differently-meaning `baseUrl` parameter.
 * Nearest preceding declaration wins; `undefined` at module scope.
 */
function enclosingFunctionName(code: string, index: number): string | undefined {
  const declaration =
    /(?:(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(|(?:private|public|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\([^)]*\)\s*:\s*[^{;]*\{)/g;
  let name: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(code)) !== null) {
    if (match.index > index) break;
    name = match[1] ?? match[2] ?? match[3] ?? name;
  }
  return name;
}

/**
 * Index of the `(` that opens the call whose callee ends at `afterCallee`,
 * skipping a balanced generic type argument list when present. Returns -1 when
 * the next token is neither `<` nor `(`.
 */
function callOpenParen(code: string, afterCallee: number): number {
  let index = afterCallee;
  while (index < code.length && /\s/.test(code[index]!)) index += 1;
  if (code[index] === '<') {
    // Balance the type-argument list. Generics legitimately contain `;`, `,`
    // and newlines (`<{ services?: Array<{ id: string }>; total?: number }>`),
    // so only bracket depth terminates the scan. A bounded window keeps a
    // less-than comparison from running away; an unbalanced scan yields -1 and
    // the mention is simply not treated as a call.
    const limit = Math.min(code.length, index + 2000);
    let depth = 0;
    let balanced = false;
    while (index < limit) {
      const char = code[index]!;
      if (char === '<') depth += 1;
      else if (char === '>') {
        depth -= 1;
        if (depth === 0) { index += 1; balanced = true; break; }
      }
      index += 1;
    }
    if (!balanced) return -1;
    while (index < code.length && /\s/.test(code[index]!)) index += 1;
  }
  return code[index] === '(' ? index : -1;
}

/** Innermost identifier of a base expression, preserving `this.x` member form. */
function baseExpressionKeys(expression: string): string[] {
  const trimmed = expression.trim();
  const keys: string[] = [trimmed];
  const member = trimmed.match(/this\.[A-Za-z_$][\w$]*/);
  if (member) keys.push(member[0]);
  const identifiers = trimmed.match(/[A-Za-z_$][\w$]*/g) ?? [];
  for (const identifier of identifiers) keys.push(identifier);
  return keys;
}

interface ResolvedUrl {
  base: string;
  rest: string;
}

/** Split a template-literal URL into its leading `${base}` and path remainder. */
function splitUrlTemplate(literal: string): ResolvedUrl | undefined {
  if (!literal.startsWith('`')) return undefined;
  const body = unquote(literal);
  const leading = body.match(/^\$\{([^}]*)\}/);
  if (!leading) return undefined;
  return { base: leading[1]!, rest: body.slice(leading[0].length) };
}

function aliasRoute(alias: ServiceAlias): ServiceAliasRoute {
  return typeof alias === 'string' ? { service: alias } : alias;
}

function methodFromInit(init: string | undefined, defaultMethod = 'GET'): string {
  const methodMatch = init?.match(/\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/);
  return methodMatch?.[2] ?? defaultMethod;
}

function proxyHelperConfigFor(
  configured: ProxyHelper,
  file: string
): ProxyHelperConfig | undefined {
  const configs = typeof configured === 'string'
    ? [{ service: configured }]
    : Array.isArray(configured)
      ? configured
      : [configured];
  return configs.find((config) => !config.files || config.files.includes(file));
}

/* -------------------------------------------------------------------------- */
/* extraction                                                                 */
/* -------------------------------------------------------------------------- */

export function extractRoutesFromSource(options: ExtractRoutesOptions): ExtractionResult {
  const {
    sourceRoot,
    proxyHelpers = {},
    serviceAliases = {},
    fetchCallees = DEFAULT_FETCH_CALLEES,
    envelopeCarriers = [],
    allowedPassthroughs = []
  } = options;

  const byId = new Map<string, ExtractedRoute>();
  const callSites: CallSite[] = [];
  const unattributed: CallSite[] = [];

  const reportUnattributed = (callSite: CallSite): void => {
    callSites.push(callSite);
    unattributed.push(callSite);
  };

  const record = (
    service: string,
    method: string,
    routePath: string,
    file: string,
    line: number,
    snippet: string,
    reason: string
  ): void => {
    const normalizedMethod = method.toUpperCase();
    const normalizedPath = normalizePath(routePath);
    const id = `${service} ${normalizedMethod} ${normalizedPath}`;
    const source = `${file}:${line}`;
    callSites.push({ file, line, snippet, reason, routeId: id });
    const existing = byId.get(id);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    byId.set(id, {
      id,
      service,
      method: normalizedMethod,
      path: normalizedPath,
      sources: [source]
    });
  };

  for (const absolute of listSourceFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, absolute).split(path.sep).join('/');
    const code = stripComments(readFileSync(absolute, 'utf8'));
    const constants = collectConstants(code);

    const resolveLiteral = (expression: string, at: number): string | undefined => {
      const trimmed = expression.trim();
      if (isQuoted(trimmed)) return trimmed;
      return resolveBinding(constants, trimmed, at);
    };

    // (1) Envelope literals: { service, method, path } anywhere, including
    // inside JSON.stringify(...) in a fetch init body.
    const servicePattern = /\bservice\s*:\s*(['"`])([\w-]+)\1/g;
    let serviceMatch: RegExpExecArray | null;
    while ((serviceMatch = servicePattern.exec(code)) !== null) {
      const service = serviceMatch[2]!;
      const objectStart = code.lastIndexOf('{', serviceMatch.index);
      if (objectStart === -1) continue;
      const objectSource = readArgs(code, objectStart).join(',');
      const methodExpression = objectSource.match(
        /\bmethod\s*:\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)/
      )?.[1];
      const pathExpression = objectSource.match(
        /\bpath\s*:\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)/
      )?.[1] ?? (/(?:^|,)\s*path\s*(?:,|$)/.test(objectSource) ? 'path' : undefined);
      const methodLiteral = resolveLiteral(methodExpression ?? '', serviceMatch.index);
      const pathLiteral = resolveLiteral(pathExpression ?? '', serviceMatch.index);
      const line = lineAt(code, serviceMatch.index);
      if (!methodLiteral || !pathLiteral) {
        // A `service:` key that does not carry a literal method+path is either
        // an unrelated object or a route the extractor cannot read. Only flag
        // the latter: require a sibling `path` or `method` key to consider it a
        // route-shaped object.
        if (/\bpath\s*:/.test(objectSource) || /\bmethod\s*:/.test(objectSource)) {
          const enclosing = enclosingFunctionName(code, serviceMatch.index);
          const configured = enclosing ? proxyHelpers[enclosing] : undefined;
          if (configured && proxyHelperConfigFor(configured, relative)) continue;
          reportUnattributed({
            file: relative,
            line,
            snippet: objectSource.slice(0, 120),
            reason: 'route-shaped envelope with a non-literal method or path'
          });
        }
        continue;
      }
      const method = unquote(methodLiteral).toUpperCase();
      if (!HTTP_METHODS.has(method)) {
        reportUnattributed({
          file: relative,
          line,
          snippet: objectSource.slice(0, 120),
          reason: `unrecognized HTTP method "${method}"`
        });
        continue;
      }
      record(
        service,
        method,
        unquote(pathLiteral),
        relative,
        line,
        objectSource.slice(0, 120),
        'literal proxy envelope'
      );
    }

    // (2) Positional proxy helpers: helper('METHOD', '/path', ...), tolerating
    // a generic type argument list of any shape between callee and `(`.
    for (const [helper, configured] of Object.entries(proxyHelpers)) {
      const helperPattern = new RegExp(`\\.${helper}\\b`, 'g');
      let helperMatch: RegExpExecArray | null;
      while ((helperMatch = helperPattern.exec(code)) !== null) {
        const config = proxyHelperConfigFor(configured, relative);
        if (!config) continue;
        const line = lineAt(code, helperMatch.index);
        const openParen = callOpenParen(code, helperMatch.index + helperMatch[0].length);
        if (openParen === -1) {
          // A mention that is not a call (declaration, reference). Declarations
          // are expected; anything else would be an unreadable call shape.
          continue;
        }
        const args = readArgs(code, openParen);
        const serviceLiteral = config.service
          ? `'${config.service}'`
          : resolveLiteral(args[config.serviceArg ?? -1] ?? '', helperMatch.index);
        const methodLiteral = config.initArg === undefined
          ? resolveLiteral(args[config.methodArg ?? 0] ?? '', helperMatch.index)
          : `'${methodFromInit(args[config.initArg], config.defaultMethod)}'`;
        const pathLiteral = resolveLiteral(args[config.pathArg ?? 1] ?? '', helperMatch.index);
        if (!serviceLiteral || !methodLiteral || !pathLiteral) {
          if (config.dynamicCallReason) {
            callSites.push({
              file: relative,
              line,
              snippet: `${helper}(${args.map((arg) => arg.slice(0, 30)).join(', ')})`,
              reason: `allowed dynamic helper call: ${config.dynamicCallReason}`
            });
            continue;
          }
          reportUnattributed({
            file: relative,
            line,
            snippet: `${helper}(${(args[0] ?? '').slice(0, 40)}, ${(args[1] ?? '').slice(0, 60)})`,
            reason: `proxy helper ${helper} called without a literal service, method, and path`
          });
          continue;
        }
        const method = unquote(methodLiteral).toUpperCase();
        if (!HTTP_METHODS.has(method)) {
          reportUnattributed({
            file: relative,
            line,
            snippet: `${helper}(${args.map((arg) => arg.slice(0, 30)).join(', ')})`,
            reason: `unrecognized HTTP method "${method}"`
          });
          continue;
        }
        record(
          unquote(serviceLiteral),
          method,
          unquote(pathLiteral),
          relative,
          line,
          `${helper}(${(args[0] ?? '').slice(0, 40)}, ${(args[1] ?? '').slice(0, 60)})`,
          `positional proxy helper ${helper}`
        );
      }
    }

    // (3) Direct fetches.
    for (const callee of fetchCallees) {
      const escaped = callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const calleePattern = new RegExp(`(^|[^\\w$.])((?:this\\.)?${escaped})\\b`, 'g');
      let calleeMatch: RegExpExecArray | null;
      while ((calleeMatch = calleePattern.exec(code)) !== null) {
        const calleeEnd = calleeMatch.index + calleeMatch[0].length;
        const openParen = callOpenParen(code, calleeEnd);
        if (openParen === -1) continue;
        const args = readArgs(code, openParen);
        const line = lineAt(code, calleeMatch.index);
        const rawUrl = (args[0] ?? '').trim();
        if (!rawUrl) continue;

        // Skip definition/aliasing sites: `fetchImpl: typeof fetch` etc. never
        // reach here because they are not call expressions.
        const carrier = envelopeCarriers.some((entry) => rawUrl === entry);
        if (carrier) continue;

        const passthrough = allowedPassthroughs.find(
          (entry) => entry.file === relative && entry.urlExpression === rawUrl
        );
        if (passthrough) {
          callSites.push({
            file: relative,
            line,
            snippet: `${callee}(${rawUrl.slice(0, 80)})`,
            reason: `allowed passthrough: ${passthrough.reason}`
          });
          continue;
        }

        const method = methodFromInit(args[1]).toUpperCase();
        if (!HTTP_METHODS.has(method)) {
          reportUnattributed({
            file: relative,
            line,
            snippet: `${callee}(... method: ${method})`,
            reason: `unrecognized HTTP method "${method}"`
          });
          continue;
        }

        const urlLiteral = resolveLiteral(rawUrl, calleeMatch.index);
        if (!urlLiteral) {
          const enclosing = enclosingFunctionName(code, calleeMatch.index);
          const candidateKeys = baseExpressionKeys(rawUrl);
          const scopedKeys = enclosing ? candidateKeys.map((key) => `${enclosing}:${key}`) : [];
          const aliasKey = [...scopedKeys, ...candidateKeys].find((key) => key in serviceAliases);
          const alias = aliasKey ? aliasRoute(serviceAliases[aliasKey]!) : undefined;
          if (alias?.path) {
            record(
              alias.service,
              method,
              alias.path,
              relative,
              line,
              `${callee}(${rawUrl.slice(0, 80)})`,
              `direct fetch via fixed service alias ${aliasKey}`
            );
            continue;
          }
          reportUnattributed({
            file: relative,
            line,
            snippet: `${callee}(${rawUrl.slice(0, 80)})`,
            reason: aliasKey
              ? `serviceAliases mapping "${aliasKey}" needs a path for this opaque URL expression`
              : 'fetch URL is not a literal and could not be resolved in this file'
          });
          continue;
        }

        const absolute = unquote(urlLiteral).match(/^https?:\/\/([^/]+)(\/.*)?$/);
        if (absolute) {
          record(
            absolute[1]!.toLowerCase(),
            method,
            absolute[2] || '/',
            relative,
            line,
            `${callee}(${urlLiteral.slice(0, 80)})`,
            'direct fetch via absolute URL'
          );
          continue;
        }

        const split = splitUrlTemplate(urlLiteral);
        if (!split) {
          reportUnattributed({
            file: relative,
            line,
            snippet: `${callee}(${urlLiteral.slice(0, 80)})`,
            reason: 'fetch URL has no leading ${base} expression to attribute to a service'
          });
          continue;
        }

        // Function-scoped aliases (`probeSessionIdentity:baseUrl`) win over bare
        // identifiers, so two functions in one file can take a same-named
        // base-URL parameter that points at different services.
        const enclosing = enclosingFunctionName(code, calleeMatch.index);
        const candidateKeys = baseExpressionKeys(split.base);
        const scopedKeys = enclosing ? candidateKeys.map((key) => `${enclosing}:${key}`) : [];
        const aliasKey = [...scopedKeys, ...candidateKeys].find((key) => key in serviceAliases);
        if (!aliasKey) {
          reportUnattributed({
            file: relative,
            line,
            snippet: `${callee}(\`\${${split.base}}...\`)`,
            reason: `base URL expression "${split.base}" has no serviceAliases mapping`
          });
          continue;
        }

        // Resolve `${sessionPath}`-style path remainders from module constants.
        let rest = split.rest;
        const wholeRest = rest.match(/^\$\{([A-Za-z_$][\w$]*)\}$/);
        if (wholeRest) {
          const resolved = resolveBinding(constants, wholeRest[1]!, calleeMatch.index);
          if (!resolved) {
            reportUnattributed({
              file: relative,
              line,
              snippet: `${callee}(\`\${${split.base}}${rest}\`)`,
              reason: `path expression "${rest}" could not be resolved to a literal`
            });
            continue;
          }
          rest = unquote(resolved);
        }

        const alias = aliasRoute(serviceAliases[aliasKey]!);
        record(
          alias.service,
          method,
          alias.path ?? rest,
          relative,
          line,
          `${callee}(${urlLiteral.slice(0, 80)})`,
          `direct fetch via service alias ${aliasKey}`
        );
      }
    }
  }

  return {
    routes: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    callSites: callSites.sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line
    ),
    unattributed: unattributed.sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line
    )
  };
}

/* -------------------------------------------------------------------------- */
/* validation                                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateRouteManifest(
  options: ValidateRouteManifestOptions
): ValidateRouteManifestResult {
  const errors: string[] = [];
  const sourceRoot = options.sourceRoot ?? path.join(options.repoRoot, 'src');
  const extraction =
    options.extraction ??
    extractRoutesFromSource({
      sourceRoot,
      ...(options.proxyHelpers ? { proxyHelpers: options.proxyHelpers } : {}),
      ...(options.serviceAliases ? { serviceAliases: options.serviceAliases } : {}),
      ...(options.fetchCallees ? { fetchCallees: options.fetchCallees } : {}),
      ...(options.envelopeCarriers ? { envelopeCarriers: options.envelopeCarriers } : {}),
      ...(options.allowedPassthroughs ? { allowedPassthroughs: options.allowedPassthroughs } : {})
    });

  const manifest = options.manifest;
  if (!isRecord(manifest)) {
    return { ok: false, errors: ['manifest must be an object'], extractedRoutes: extraction.routes };
  }
  if (manifest.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`);
  }
  if (!Array.isArray(manifest.routes)) {
    return {
      ok: false,
      errors: [...errors, 'manifest.routes must be an array'],
      extractedRoutes: extraction.routes
    };
  }

  for (const callSite of extraction.unattributed) {
    errors.push(
      `unattributed HTTP call site ${callSite.file}:${callSite.line} (${callSite.reason}): ${callSite.snippet}`
    );
  }

  const seenIds = new Set<string>();
  const manifestKeys = new Map<string, RouteManifestRoute>();

  for (const [index, entry] of (manifest.routes as unknown[]).entries()) {
    const label = `routes[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const route = entry as unknown as RouteManifestRoute;
    for (const field of ['id', 'service', 'method', 'path', 'classification'] as const) {
      if (typeof route[field] !== 'string' || route[field].trim() === '') {
        errors.push(`${label}.${field} must be a non-empty string`);
      }
    }
    if (typeof route.id === 'string') {
      if (seenIds.has(route.id)) errors.push(`${label} duplicate id ${route.id}`);
      seenIds.add(route.id);
    }
    if (
      typeof route.classification === 'string' &&
      !ROUTE_CLASSIFICATIONS.includes(route.classification)
    ) {
      errors.push(
        `${label}.classification must be one of ${ROUTE_CLASSIFICATIONS.join(' | ')}, got ${route.classification}`
      );
    }
    if (typeof route.method === 'string' && route.method !== route.method.toUpperCase()) {
      errors.push(`${label}.method must be uppercase, got ${route.method}`);
    }
    if (typeof route.method === 'string' && !HTTP_METHODS.has(route.method.toUpperCase())) {
      errors.push(`${label}.method is not a recognized HTTP method: ${route.method}`);
    }
    if (typeof route.path === 'string' && !route.path.startsWith('/')) {
      errors.push(`${label}.path must start with /`);
    }
    if (route.classification !== 'simulated') {
      if (typeof route.reason !== 'string' || route.reason.trim() === '') {
        errors.push(`${label}.reason is required when classification is ${route.classification}`);
      }
      if (Array.isArray(route.cassettes) && route.cassettes.length > 0) {
        errors.push(`${label} is ${route.classification} but lists cassettes`);
      }
    } else {
      if (!Array.isArray(route.cassettes) || route.cassettes.length === 0) {
        errors.push(`${label} is simulated but lists no cassettes`);
      } else {
        for (const cassette of route.cassettes) {
          if (typeof cassette !== 'string' || cassette.trim() === '') {
            errors.push(`${label}.cassettes entries must be non-empty strings`);
            continue;
          }
          const cassettePath = path.resolve(options.repoRoot, cassette);
          const relative = path.relative(options.repoRoot, cassettePath);
          if (path.isAbsolute(cassette) || relative.startsWith('..') || path.isAbsolute(relative)) {
            errors.push(`${label} simulated cassette escapes the repository: ${cassette}`);
          } else if (!existsSync(cassettePath) || !statSync(cassettePath).isFile()) {
            errors.push(`${label} simulated cassette not found: ${cassette}`);
          }
        }
      }
    }
    if (
      typeof route.service === 'string' &&
      typeof route.method === 'string' &&
      typeof route.path === 'string'
    ) {
      const key = `${route.service} ${route.method} ${route.path}`;
      if (manifestKeys.has(key)) errors.push(`${label} duplicate route key ${key}`);
      manifestKeys.set(key, route);
    }
  }

  const extractedKeys = new Set(extraction.routes.map((route) => route.id));
  for (const route of extraction.routes) {
    if (!manifestKeys.has(route.id)) {
      errors.push(
        `unmanifested route ${route.id} (called from ${route.sources.join(', ')}); add it to tests/contract/route-manifest.json`
      );
    }
  }
  for (const key of manifestKeys.keys()) {
    if (!extractedKeys.has(key)) {
      errors.push(`stale manifest entry ${key} has no matching route in src/`);
    }
  }

  return { ok: errors.length === 0, errors, extractedRoutes: extraction.routes };
}

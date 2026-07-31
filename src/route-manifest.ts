import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from 'node:fs';
import path from 'node:path';

export const ROUTE_CLASSIFICATIONS = [
  'simulated',
  'live-only',
  'intentionally-unsimulated'
] as const;

export type RouteClassification = (typeof ROUTE_CLASSIFICATIONS)[number];

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
  schemaVersion: 1;
  routes: RouteManifestRoute[];
}

export interface ExtractedRoute {
  service: string;
  method: string;
  path: string;
  sourceFiles: string[];
}

export interface ExtractRoutesOptions {
  sourceRoot: string;
}

export interface ValidateRouteManifestOptions {
  repoRoot: string;
  sourceRoot?: string;
  manifest: unknown;
}

export interface RouteManifestValidationResult {
  ok: boolean;
  errors: string[];
  extractedRoutes: ExtractedRoute[];
}

interface RouteTriple {
  service: string;
  method: string;
  path: string;
}

interface Span {
  start: number;
  end: number;
}

const HTTP_METHOD = /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/;
const ROUTE_SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;

function routeKey(route: RouteTriple): string {
  return `${route.service}\u0000${route.method.toUpperCase()}\u0000${route.path}`;
}

function walkSourceFiles(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(root, entryPath));
    } else if (entry.isFile() && ROUTE_SOURCE_EXTENSION.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function syntaxMask(source: string): string {
  const chars = [...source];
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      else chars[index] = ' ';
      continue;
    }
    if (blockComment) {
      chars[index] = char === '\n' ? '\n' : ' ';
      if (char === '*' && next === '/') {
        chars[index + 1] = ' ';
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      chars[index] = char === '\n' ? '\n' : ' ';
      if (char === '\\') {
        if (index + 1 < chars.length) chars[index + 1] = ' ';
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      lineComment = true;
      index += 1;
    } else if (char === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      blockComment = true;
      index += 1;
    } else if (char === "'" || char === '"' || char === '`') {
      chars[index] = ' ';
      quote = char;
    }
  }
  return chars.join('');
}

function findMatching(
  source: string,
  openIndex: number,
  openChar: '(' | '{' | '[',
  closeChar: ')' | '}' | ']'
): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(value: string, delimiter = ','): string[] {
  const parts: string[] = [];
  let start = 0;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const next = value[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses -= 1;
    else if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (
      char === delimiter &&
      parentheses === 0 &&
      braces === 0 &&
      brackets === 0
    ) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function topLevelColon(value: string): number {
  const parts = splitTopLevel(value, ':');
  if (parts.length < 2) return -1;
  return parts[0]!.length + value.slice(parts[0]!.length).indexOf(':');
}

function objectProperties(value: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const part of splitTopLevel(value)) {
    const colon = topLevelColon(part);
    if (colon < 0) continue;
    const rawName = part.slice(0, colon).trim();
    const name = rawName.replace(/^['"]|['"]$/g, '');
    if (!/^[A-Za-z_$][\w$-]*$/.test(name)) continue;
    properties.set(name, part.slice(colon + 1).trim());
  }
  return properties;
}

function decodeQuoted(value: string): string | null {
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) return null;
  return value
    .slice(1, -1)
    .replace(/\\([\\'"`])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function placeholder(expression: string): string {
  void expression;
  return '{param}';
}

function normalizeTemplate(
  value: string,
  constants: Map<string, string>,
  seen: Set<string>
): string | null {
  if (!value.startsWith('`') || !value.endsWith('`')) return null;
  let output = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (char === '\\') {
      const next = value[index + 1];
      if (next !== undefined) {
        output += next;
        index += 1;
      }
      continue;
    }
    if (char === '$' && value[index + 1] === '{') {
      let depth = 1;
      let end = index + 2;
      let quote: "'" | '"' | '`' | null = null;
      for (; end < value.length - 1; end += 1) {
        const inner = value[end]!;
        if (quote) {
          if (inner === '\\') end += 1;
          else if (inner === quote) quote = null;
          continue;
        }
        if (inner === "'" || inner === '"' || inner === '`') quote = inner;
        else if (inner === '{') depth += 1;
        else if (inner === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) return null;
      const expression = value.slice(index + 2, end);
      const resolved = staticString(expression, constants, new Set(seen));
      output += resolved ?? placeholder(expression);
      index = end;
      continue;
    }
    output += char;
  }
  return output;
}

function collectConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const pattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    constants.set(match[1]!, match[2]!.trim());
  }
  return constants;
}

function staticString(
  expression: string | undefined,
  constants: Map<string, string>,
  seen = new Set<string>()
): string | null {
  if (!expression) return null;
  const value = expression.trim().replace(/\s+as\s+const$/, '');
  const quoted = decodeQuoted(value);
  if (quoted !== null) return quoted;
  const template = normalizeTemplate(value, constants, seen);
  if (template !== null) return template;
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    if (seen.has(value)) return null;
    const constant = constants.get(value);
    if (!constant) return null;
    seen.add(value);
    return staticString(constant, constants, seen);
  }
  const concatenated = splitTopLevel(value, '+');
  if (concatenated.length > 1) {
    let output = '';
    for (const part of concatenated) {
      const resolved = staticString(part, constants, new Set(seen));
      output += resolved ?? placeholder(part);
    }
    return output;
  }
  return null;
}

function braceSpans(source: string): Span[] {
  const mask = syntaxMask(source);
  const stack: number[] = [];
  const spans: Span[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === '{') stack.push(index);
    else if (mask[index] === '}') {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: index });
    }
  }
  return spans;
}

function routeFromProperties(
  properties: Map<string, string>,
  constants: Map<string, string>
): RouteTriple | null {
  const service = staticString(properties.get('service'), constants)?.trim();
  const method = staticString(properties.get('method'), constants)?.trim().toUpperCase();
  const routePath = staticString(properties.get('path'), constants)?.trim();
  if (!service || !method || !routePath || !HTTP_METHOD.test(method) || !routePath.startsWith('/')) {
    return null;
  }
  return { service, method, path: routePath };
}

function objectRoutes(source: string, constants: Map<string, string>): RouteTriple[] {
  const mask = syntaxMask(source);
  const spans = braceSpans(source);
  const routes: RouteTriple[] = [];
  const servicePattern = /\bservice\s*:/g;
  let match: RegExpExecArray | null;
  const visited = new Set<number>();
  while ((match = servicePattern.exec(mask))) {
    const span = spans
      .filter((candidate) => candidate.start < match!.index && candidate.end > match!.index)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
    if (!span || visited.has(span.start)) continue;
    visited.add(span.start);
    const route = routeFromProperties(
      objectProperties(source.slice(span.start + 1, span.end)),
      constants
    );
    if (route) routes.push(route);
  }
  return routes;
}

const HELPER_NAME = '(?:proxyRequest|proxyJson|[A-Za-z_$][\\w$]*(?:ProxyRequest|ProxyJson))';

function fixedHelperServices(source: string, constants: Map<string, string>): Map<string, string> {
  const services = new Map<string, Set<string>>();
  const mask = syntaxMask(source);
  const definitionPattern = new RegExp(
    `(?:\\bfunction\\s+|\\b(?:(?:private|protected|public|static|async)\\s+)+)(${HELPER_NAME})\\s*(?:<[^>{}]*>)?\\s*\\(`,
    'g'
  );
  let match: RegExpExecArray | null;
  while ((match = definitionPattern.exec(mask))) {
    const openParenthesis = mask.indexOf('(', match.index);
    const closeParenthesis = findMatching(source, openParenthesis, '(', ')');
    if (closeParenthesis < 0) continue;
    let angleDepth = 0;
    let openBrace = -1;
    for (let index = closeParenthesis + 1; index < mask.length; index += 1) {
      if (mask[index] === '<') angleDepth += 1;
      else if (mask[index] === '>') angleDepth = Math.max(0, angleDepth - 1);
      else if (mask[index] === '{' && angleDepth === 0) {
        openBrace = index;
        break;
      }
      if (mask[index] === ';' && angleDepth === 0) break;
    }
    if (openBrace < 0) continue;
    const closeBrace = findMatching(source, openBrace, '{', '}');
    if (closeBrace < 0) continue;
    for (const route of objectRoutes(source.slice(openBrace + 1, closeBrace), constants)) {
      const set = services.get(match[1]!) ?? new Set<string>();
      set.add(route.service);
      services.set(match[1]!, set);
    }
    const body = source.slice(openBrace + 1, closeBrace);
    const serviceLiteral = body.match(/\bservice\s*:\s*(['"])([^'"]+)\1/);
    if (serviceLiteral) {
      const set = services.get(match[1]!) ?? new Set<string>();
      set.add(serviceLiteral[2]!);
      services.set(match[1]!, set);
    }
  }
  const fixed = new Map<string, string>();
  for (const [helper, values] of services) {
    if (values.size === 1) fixed.set(helper, [...values][0]!);
  }
  return fixed;
}

function helperRoutes(source: string, constants: Map<string, string>): RouteTriple[] {
  const mask = syntaxMask(source);
  const fixedServices = fixedHelperServices(source, constants);
  const fileServices = new Set(fixedServices.values());
  const onlyFileService = fileServices.size === 1 ? [...fileServices][0] : undefined;
  const routes: RouteTriple[] = [];
  const callPattern = new RegExp(`\\b(${HELPER_NAME})\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(mask))) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(mask[cursor] ?? '')) cursor += 1;
    if (mask[cursor] === '<') {
      let angleDepth = 0;
      for (; cursor < mask.length; cursor += 1) {
        if (mask[cursor] === '<') angleDepth += 1;
        else if (mask[cursor] === '>') {
          angleDepth -= 1;
          if (angleDepth === 0) {
            cursor += 1;
            break;
          }
        }
      }
      while (/\s/.test(mask[cursor] ?? '')) cursor += 1;
    }
    if (mask[cursor] !== '(') continue;
    const open = cursor;
    const close = findMatching(source, open, '(', ')');
    if (close < 0) continue;
    const args = splitTopLevel(source.slice(open + 1, close));
    const scopedConstants = collectConstants(source.slice(0, match.index));
    const first = staticString(args[0], scopedConstants)?.trim();
    const second = staticString(args[1], scopedConstants)?.trim();
    const third = staticString(args[2], scopedConstants)?.trim();
    if (first && second && third && HTTP_METHOD.test(second.toUpperCase()) && third.startsWith('/')) {
      routes.push({ service: first, method: second.toUpperCase(), path: third });
      continue;
    }
    const fixedService = fixedServices.get(match[1]!) ?? onlyFileService;
    if (fixedService && first && second && HTTP_METHOD.test(first.toUpperCase()) && second.startsWith('/')) {
      routes.push({ service: fixedService, method: first.toUpperCase(), path: second });
    }
  }
  return routes;
}

function directServiceHint(expression: string | undefined): string | undefined {
  if (!expression) return undefined;
  if (/observabilityBaseUrl/i.test(expression)) return 'observability';
  if (/(?:apiHost|apiBaseUrl|apiBase|postmanApi)/i.test(expression)) return 'postman-api';
  if (/(?:iapub|identityBaseUrl|sessionBaseUrl)/i.test(expression)) return 'iapub';
  return undefined;
}

function directRoute(url: string, method: string, serviceHint?: string): RouteTriple | null {
  if (!HTTP_METHOD.test(method)) return null;
  const absolute = url.match(/^https?:\/\/([^/{}]+)(\/.*)?$/);
  if (absolute) {
    return {
      service: absolute[1]!.toLowerCase(),
      method,
      path: absolute[2] || '/'
    };
  }
  const pathStart = url.indexOf('/');
  const routePath = pathStart >= 0 ? url.slice(pathStart) : '';
  if (!routePath || routePath === '/ws/proxy') return null;
  const knownServices: Array<[RegExp, string]> = [
    [/^\/repos\//, 'api.github.com'],
    [/^\/me(?:\?|$)/, 'postman-api'],
    [/^\/service-account-tokens(?:\?|$)/, 'postman-api'],
    [/^\/api\/sessions\/current(?:\?|$)/, 'iapub'],
    [/^\/api\/app-?[Vv]ersion(?:\?|$)/, 'app-version']
  ];
  const service = knownServices.find(([pattern]) => pattern.test(routePath))?.[1] ?? serviceHint;
  return service ? { service, method, path: routePath } : null;
}

function fetchRoutes(source: string): RouteTriple[] {
  const mask = syntaxMask(source);
  const routes: RouteTriple[] = [];
  const callPattern = /(?:\bfetch|\bfetcher|\bfetchFn|\bfetchImpl|\bfetchWithDeadline)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(mask))) {
    const open = mask.indexOf('(', match.index);
    const close = findMatching(source, open, '(', ')');
    if (close < 0) continue;
    const args = splitTopLevel(source.slice(open + 1, close));
    const scopedConstants = collectConstants(source.slice(0, match.index));
    const url = staticString(args[0], scopedConstants);
    if (!url) continue;
    let method = 'GET';
    const init = args[1]?.trim();
    if (init?.startsWith('{') && init.endsWith('}')) {
      const properties = objectProperties(init.slice(1, -1));
      method = staticString(properties.get('method'), scopedConstants)?.toUpperCase() ?? method;
    }
    const route = directRoute(url, method, directServiceHint(args[0]));
    if (route) routes.push(route);
  }
  return routes;
}

function extractFileRoutes(source: string): RouteTriple[] {
  const constants = collectConstants(source);
  return [
    ...objectRoutes(source, constants),
    ...helperRoutes(source, constants),
    ...fetchRoutes(source)
  ];
}

export function extractRoutesFromSource(options: ExtractRoutesOptions): ExtractedRoute[] {
  const root = path.resolve(options.sourceRoot);
  const routes = new Map<string, ExtractedRoute>();
  for (const file of walkSourceFiles(root)) {
    const relativeFile = path.relative(root, file).split(path.sep).join('/');
    for (const route of extractFileRoutes(readFileSync(file, 'utf8'))) {
      const normalized: RouteTriple = {
        service: route.service.trim(),
        method: route.method.trim().toUpperCase(),
        path: route.path.trim()
      };
      const key = routeKey(normalized);
      const existing = routes.get(key);
      if (existing) {
        if (!existing.sourceFiles.includes(relativeFile)) {
          existing.sourceFiles.push(relativeFile);
          existing.sourceFiles.sort((left, right) => left.localeCompare(right));
        }
      } else {
        routes.set(key, { ...normalized, sourceFiles: [relativeFile] });
      }
    }
  }
  return [...routes.values()].sort((left, right) =>
    routeKey(left).localeCompare(routeKey(right))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRoute(
  value: unknown,
  index: number,
  repoRoot: string,
  errors: string[]
): RouteManifestRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`Route at index ${index} must be an object`);
    return null;
  }
  const route = value as Record<string, unknown>;
  if (!nonEmptyString(route.id)) errors.push(`Route at index ${index} must have a non-empty id`);
  if (!nonEmptyString(route.service)) errors.push(`Route at index ${index} must have a non-empty service`);
  if (!nonEmptyString(route.method) || !HTTP_METHOD.test(route.method)) {
    errors.push(`Route at index ${index} must have an uppercase HTTP method`);
  }
  if (!nonEmptyString(route.path) || !route.path.startsWith('/')) {
    errors.push(`Route at index ${index} path must start with /`);
  }
  if (!ROUTE_CLASSIFICATIONS.includes(route.classification as RouteClassification)) {
    errors.push(`Route at index ${index} has an invalid classification`);
  }
  if (
    route.classification !== 'simulated' &&
    (!nonEmptyString(route.reason))
  ) {
    errors.push(
      `Route at index ${index} with classification ${String(route.classification)} must have a reason`
    );
  }
  if (route.classification === 'simulated') {
    if (!Array.isArray(route.cassettes) || route.cassettes.length === 0) {
      errors.push(`Route ${nonEmptyString(route.id) ? route.id : `at index ${index}`} must list cassettes`);
    } else {
      for (const cassette of route.cassettes) {
        if (!nonEmptyString(cassette) || path.isAbsolute(cassette)) {
          errors.push(`Route ${String(route.id)} cassette must be a relative path`);
          continue;
        }
        const cassettePath = path.resolve(repoRoot, cassette);
        const relative = path.relative(repoRoot, cassettePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          errors.push(`Route ${String(route.id)} cassette escapes the repository: ${cassette}`);
        } else if (!existsSync(cassettePath) || !statSync(cassettePath).isFile()) {
          errors.push(`Route ${String(route.id)} cassette does not exist: ${cassette}`);
        }
      }
    }
  }
  if (
    !nonEmptyString(route.id) ||
    !nonEmptyString(route.service) ||
    !nonEmptyString(route.method) ||
    !nonEmptyString(route.path) ||
    !ROUTE_CLASSIFICATIONS.includes(route.classification as RouteClassification)
  ) {
    return null;
  }
  return route as unknown as RouteManifestRoute;
}

export function validateRouteManifest(
  options: ValidateRouteManifestOptions
): RouteManifestValidationResult {
  const repoRoot = path.resolve(options.repoRoot);
  const sourceRoot = path.resolve(options.sourceRoot ?? path.join(repoRoot, 'src'));
  const extractedRoutes = extractRoutesFromSource({ sourceRoot });
  const errors: string[] = [];
  if (!options.manifest || typeof options.manifest !== 'object' || Array.isArray(options.manifest)) {
    return { ok: false, errors: ['Manifest must be an object'], extractedRoutes };
  }
  const manifest = options.manifest as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) errors.push('Manifest schemaVersion must be 1');
  if (!Array.isArray(manifest.routes)) {
    errors.push('Manifest routes must be an array');
    return { ok: false, errors, extractedRoutes };
  }

  const routes = manifest.routes
    .map((route, index) => validateRoute(route, index, repoRoot, errors))
    .filter((route): route is RouteManifestRoute => route !== null);
  const ids = new Set<string>();
  const manifestByKey = new Map<string, RouteManifestRoute>();
  for (const route of routes) {
    if (ids.has(route.id)) errors.push(`Duplicate route id: ${route.id}`);
    ids.add(route.id);
    const key = routeKey(route);
    const duplicate = manifestByKey.get(key);
    if (duplicate) {
      errors.push(`Duplicate route triple: ${duplicate.id} and ${route.id}`);
    } else {
      manifestByKey.set(key, route);
    }
  }

  const extractedByKey = new Map(extractedRoutes.map((route) => [routeKey(route), route]));
  for (const extracted of extractedRoutes) {
    if (!manifestByKey.has(routeKey(extracted))) {
      errors.push(
        `Unmanifested route: ${extracted.service} ${extracted.method} ${extracted.path} (${extracted.sourceFiles.join(', ')})`
      );
    }
  }
  for (const route of routes) {
    if (!extractedByKey.has(routeKey(route))) {
      errors.push(`Stale manifest route ${route.id}: ${route.service} ${route.method} ${route.path}`);
    }
  }

  return { ok: errors.length === 0, errors, extractedRoutes };
}

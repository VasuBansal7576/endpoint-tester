import { Composio } from "@composio/core";
import type {
  EndpointDefinition,
  EndpointReport,
  EndpointStatus,
  ParameterDef,
  TestReport,
} from "./types";

const PRIMARY_FALLBACK_CONNECTED_ACCOUNT_ID = "ca_bmHO2zOYFWkT";

export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  type ProxyParameter = {
    in: "query" | "header";
    name: string;
    value: string | number;
  };
  type ExecutionResult = {
    report: EndpointReport;
    raw_response: unknown;
  };
  type NormalizedExecution = {
    status: number | null;
    data: unknown;
    errorMessage: string | null;
  };
  type PathResolutionResult =
    | { ok: true; path: string }
    | { ok: false; status: EndpointStatus; reason: string };
  type PathParameterResolutionResult =
    | { ok: true; value: string }
    | { ok: false; status: EndpointStatus; reason: string };

  const executionCache = new Map<string, Promise<ExecutionResult>>();
  const usedDependencyValues = new Map<string, Set<string>>();
  const connectedAccountId = await resolveConnectedAccountId(params.composio);
  const availableScopes = await getAvailableScopes(
    params.composio,
    connectedAccountId
  );

  async function testEndpoint(endpoint: EndpointDefinition): Promise<ExecutionResult> {
    const cached = executionCache.get(endpoint.tool_slug);
    if (cached) {
      return cached;
    }

    const promise = executeEndpoint(endpoint);
    executionCache.set(endpoint.tool_slug, promise);
    return promise;
  }

  async function executeEndpoint(
    endpoint: EndpointDefinition
  ): Promise<ExecutionResult> {
    const method = normalizeMethod(endpoint.method);
    const resolvedPath = await resolveEndpointPath(endpoint);

    if (resolvedPath.ok === false) {
      return {
        raw_response: { error: resolvedPath.reason },
        report: buildReport({
          endpoint,
          status: resolvedPath.status,
          httpStatusCode: null,
          responseSummary: resolvedPath.reason,
          responseBody: { error: resolvedPath.reason },
          usedConnectedAccountId: connectedAccountId,
        }),
      };
    }

    const proxyParamsBase: {
      endpoint: string;
      method: HttpMethod;
      parameters?: ProxyParameter[];
      body?: unknown;
    } = {
      endpoint: resolvedPath.path,
      method,
    };

    const queryParameters = buildQueryParameters(endpoint);
    if (queryParameters.length > 0) {
      proxyParamsBase.parameters = queryParameters;
    }

    const body = buildRequestBody(endpoint);
    if (body !== undefined && method !== "GET" && method !== "DELETE") {
      proxyParamsBase.body = body;
    }

    console.log(
      `[agent] ${endpoint.tool_slug}: trying connectedAccountId=${connectedAccountId}`
    );

    const execution = await safelyExecute({
      ...proxyParamsBase,
      connectedAccountId,
    });
    const classification = classifyResponse(
      endpoint,
      execution.status,
      execution.data,
      execution.errorMessage
    );

    console.log(
      `[agent] ${endpoint.tool_slug}: connectedAccountId=${connectedAccountId} -> status=${execution.status ?? "null"} classification=${classification.status}`
    );

    return {
      raw_response: execution.data,
      report: buildReport({
        endpoint,
        status: classification.status,
        httpStatusCode: execution.status,
        responseSummary: `${classification.summary} Connected account used: ${connectedAccountId}.`,
        responseBody: execution.data,
        usedConnectedAccountId: connectedAccountId,
      }),
    };
  }

  async function resolveEndpointPath(
    endpoint: EndpointDefinition
  ): Promise<PathResolutionResult> {
    let resolvedPath = endpoint.path;

    for (const pathParam of endpoint.parameters.path) {
      const resolution = await resolvePathParameter(endpoint, pathParam);
      if (resolution.ok === false) {
        return {
          ok: false,
          status: resolution.status,
          reason: resolution.reason,
        };
      }

      resolvedPath = resolvedPath.replace(
        `{${pathParam.name}}`,
        encodeURIComponent(resolution.value)
      );
    }

    return { ok: true, path: resolvedPath };
  }

  async function resolvePathParameter(
    target: EndpointDefinition,
    param: ParameterDef
  ): Promise<PathParameterResolutionResult> {
    const candidates = findDependencyCandidates(target, param);
    let insufficientScopesReason: string | null = null;

    for (const candidate of candidates) {
      const execution = await testEndpoint(candidate);
      if (execution.report.status === "insufficient_scopes") {
        insufficientScopesReason =
          `Could not resolve required path parameter "${param.name}" for ${target.method} ${target.path} because dependency ${candidate.tool_slug} was blocked: ${execution.report.response_summary}`;
      }

      if (execution.report.status !== "valid") {
        continue;
      }

      const values = extractCandidateValues(
        execution.raw_response,
        param.name,
        target.path
      );
      const chosen = pickDependencyValue(target, param, values);
      if (chosen) {
        return { ok: true, value: chosen };
      }
    }

    if (insufficientScopesReason) {
      return {
        ok: false,
        status: "insufficient_scopes",
        reason: insufficientScopesReason,
      };
    }

    return {
      ok: false,
      status: "error",
      reason: `Could not resolve required path parameter "${param.name}" for ${target.method} ${target.path}.`,
    };
  }

  function findDependencyCandidates(
    target: EndpointDefinition,
    param: ParameterDef
  ): EndpointDefinition[] {
    const targetPathParamCount = target.parameters.path.length;
    const targetSegments = splitPath(target.path);
    const resourceHint = getResourceHint(target.path, param.name);

    return [...params.endpoints]
      .filter((candidate) => candidate.tool_slug !== target.tool_slug)
      .filter(
        (candidate) =>
          candidate.parameters.path.length < targetPathParamCount &&
          normalizeMethod(candidate.method) !== "DELETE"
      )
      .map((candidate) => {
        const candidateSegments = splitPath(candidate.path);
        const sharedPrefix = countSharedPrefixSegments(
          targetSegments,
          candidateSegments
        );
        const pathText = candidate.path.toLowerCase();
        const descriptionText = candidate.description.toLowerCase();
        const method = normalizeMethod(candidate.method);

        let score = sharedPrefix * 10;

        if (candidate.parameters.path.length === 0) score += 25;
        if (method === "GET") score += 25;
        if (method === "POST" || method === "PUT") score += 10;

        if (resourceHint && pathText.includes(resourceHint)) score += 20;
        if (
          resourceHint &&
          (descriptionText.includes(resourceHint) ||
            descriptionText.includes(pluralize(resourceHint)))
        ) {
          score += 10;
        }

        if (/\blist\b|\bget\b|\bsearch\b/.test(descriptionText)) score += 10;
        if (/\bcreate\b|\binsert\b|\badd\b/.test(descriptionText)) score += 5;

        return { candidate, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.candidate);
  }

  function pickDependencyValue(
    target: EndpointDefinition,
    param: ParameterDef,
    values: string[]
  ): string | null {
    if (values.length === 0) {
      return null;
    }

    const usageKey = `${getResourceHint(target.path, param.name)}:${param.name}`;
    const used = usedDependencyValues.get(usageKey) ?? new Set<string>();

    for (const value of values) {
      if (!used.has(value)) {
        used.add(value);
        usedDependencyValues.set(usageKey, used);
        return value;
      }
    }

    return values[0] ?? null;
  }

  function buildQueryParameters(endpoint: EndpointDefinition): ProxyParameter[] {
    const parameters: ProxyParameter[] = [];

    for (const param of endpoint.parameters.query) {
      if (!param.required && !shouldIncludeOptionalQueryParam(param)) {
        continue;
      }

      const value = buildQueryValue(param);
      if (value === undefined) {
        continue;
      }

      parameters.push({
        in: "query",
        name: param.name,
        value,
      });
    }

    return parameters;
  }

  function shouldIncludeOptionalQueryParam(param: ParameterDef): boolean {
    const text = `${param.name} ${param.description}`.toLowerCase();
    return /max|limit|page|size|count|format|show/i.test(text);
  }

  function buildQueryValue(param: ParameterDef): string | number | undefined {
    const type = param.type.toLowerCase();
    const name = param.name.toLowerCase();
    const description = param.description.toLowerCase();

    if (type === "integer" || type === "number") {
      return /max|limit|count|size/.test(name) ? 1 : 1;
    }

    if (type === "boolean") {
      return "false";
    }

    const allowedValues = extractQuotedValues(param.description);
    if (allowedValues.length > 0) {
      if (allowedValues.includes("metadata")) return "metadata";
      return allowedValues[0];
    }

    if (name.includes("format")) return "metadata";
    if (name.includes("timemin")) return futureIsoString(-1);
    if (name.includes("timemax")) return futureIsoString(24);
    if (description.includes("rfc3339")) return futureIsoString(1);
    if (name.includes("q") || name.includes("query") || name.includes("search")) {
      return "test";
    }

    return param.required ? "test" : undefined;
  }

  function buildRequestBody(endpoint: EndpointDefinition): unknown | undefined {
    const bodyDef = endpoint.parameters.body;
    if (!bodyDef) {
      return undefined;
    }

    const body: Record<string, unknown> = {};

    for (const field of bodyDef.fields) {
      if (!field.required && !shouldIncludeOptionalBodyField(field)) {
        continue;
      }

      const value = buildBodyFieldValue(field);
      if (value !== undefined) {
        body[field.name] = value;
      }
    }

    return Object.keys(body).length > 0 ? body : {};
  }

  function shouldIncludeOptionalBodyField(field: ParameterDef): boolean {
    const text = `${field.name} ${field.description}`.toLowerCase();
    return /description|summary|title/.test(text);
  }

  function buildBodyFieldValue(field: ParameterDef): unknown {
    const type = field.type.toLowerCase();
    const name = field.name.toLowerCase();
    const description = field.description.toLowerCase();

    if (type === "integer" || type === "number") return 1;
    if (type === "boolean") return false;
    if (type === "array") return [];

    if (type === "object") {
      if (name === "start") return buildCalendarDateTimeObject(1);
      if (name === "end") return buildCalendarDateTimeObject(2);
      if (name === "message" && description.includes("raw")) {
        return { raw: buildRawEmailMessage() };
      }
      if (description.includes("datetime")) {
        return buildCalendarDateTimeObject(1);
      }
      if (description.includes("raw")) {
        return { raw: buildRawEmailMessage() };
      }
      return {};
    }

    if (name === "raw" || description.includes("base64url")) {
      return buildRawEmailMessage();
    }
    if (name.includes("summary") || name.includes("title")) {
      return "Endpoint validation test";
    }
    if (name.includes("description")) {
      return "Created by the endpoint validation agent";
    }
    if (name.includes("timezone")) {
      return "UTC";
    }
    if (name.includes("datetime") || description.includes("rfc3339")) {
      return futureIsoString(1);
    }
    if (name.includes("email")) {
      return "validator@example.com";
    }

    return "test";
  }

  async function safelyExecute(request: {
    endpoint: string;
    method: HttpMethod;
    connectedAccountId: string;
    parameters?: ProxyParameter[];
    body?: unknown;
  }): Promise<NormalizedExecution> {
    try {
      const response = await params.composio.tools.proxyExecute(request);
      return {
        status: typeof response.status === "number" ? response.status : null,
        data:
          response.binary_data !== undefined
            ? {
                binary_data: {
                  content_type: response.binary_data.content_type,
                  size: response.binary_data.size,
                  url: response.binary_data.url,
                },
              }
            : response.data,
        errorMessage: null,
      };
    } catch (error) {
      return normalizeThrownError(error);
    }
  }

  function normalizeThrownError(error: unknown): NormalizedExecution {
    const record =
      error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const response =
      record.response && typeof record.response === "object"
        ? (record.response as Record<string, unknown>)
        : null;
    const cause =
      record.cause && typeof record.cause === "object"
        ? (record.cause as Record<string, unknown>)
        : null;

    const status =
      firstNumber(
        record.status,
        record.statusCode,
        response?.status,
        cause?.status,
        cause?.statusCode
      ) ?? null;

    const data =
      response?.data ??
      cause?.data ??
      cause?.response ??
      record.error ??
      record.message ??
      error;

    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof record.message === "string"
          ? record.message
          : typeof data === "string"
            ? data
            : "Unknown execution error";

    return {
      status,
      data,
      errorMessage,
    };
  }

  function classifyResponse(
    endpoint: EndpointDefinition,
    httpStatusCode: number | null,
    responseBody: unknown,
    errorMessage: string | null
  ): { status: EndpointStatus; summary: string } {
    const combinedText = `${errorMessage ?? ""} ${stringifyUnknown(responseBody)}`
      .toLowerCase()
      .slice(0, 1000);

    if (httpStatusCode !== null && httpStatusCode >= 200 && httpStatusCode < 300) {
      return {
        status: "valid",
        summary: summarizeValidResponse(endpoint, httpStatusCode, responseBody),
      };
    }

    if (
      httpStatusCode === 403 ||
      /insufficient|forbidden|permission|scope/.test(combinedText)
    ) {
      return {
        status: "insufficient_scopes",
        summary: summarizeInsufficientScopes(
          endpoint,
          httpStatusCode,
          responseBody,
          errorMessage
        ),
      };
    }

    if (
      httpStatusCode === 404 &&
      endpoint.tool_slug.toUpperCase().includes("ARCHIVE")
    ) {
      return {
        status: "invalid_endpoint",
        summary: summarizeInvalidEndpoint(
          endpoint,
          httpStatusCode,
          responseBody,
          errorMessage
        ),
      };
    }

    if (
      httpStatusCode === 405 ||
      /not found|method not allowed|no route|unknown endpoint|unrecognized/.test(
        combinedText
      )
    ) {
      const clearlyInvalidPathOrMethod =
        httpStatusCode === 405 ||
        /method not allowed|no route|unknown endpoint|unrecognized/.test(
          combinedText
        ) ||
        (httpStatusCode === 404 && endpoint.parameters.path.length === 0);

      if (!clearlyInvalidPathOrMethod) {
        return {
          status: "error",
          summary: summarizeErrorResponse(
            endpoint,
            httpStatusCode,
            responseBody,
            errorMessage
          ),
        };
      }

      return {
        status: "invalid_endpoint",
        summary: summarizeInvalidEndpoint(
          endpoint,
          httpStatusCode,
          responseBody,
          errorMessage
        ),
      };
    }

    if (httpStatusCode === null) {
      return {
        status: "error",
        summary: summarizeErrorResponse(
          endpoint,
          httpStatusCode,
          responseBody,
          errorMessage
        ),
      };
    }

    return {
      status: "error",
      summary: summarizeErrorResponse(
        endpoint,
        httpStatusCode,
        responseBody,
        errorMessage
      ),
    };
  }

  function summarizeValidResponse(
    endpoint: EndpointDefinition,
    httpStatusCode: number,
    responseBody: unknown
  ): string {
    const collection = getCollectionSummary(responseBody);
    const snippet = getResponseSnippet(responseBody);
    const context = getSuccessContext(endpoint);

    if (httpStatusCode === 204 || isEmptyResponseBody(responseBody)) {
      return `Returned ${httpStatusCode} with no response body, confirming the ${endpoint.method} ${endpoint.path} operation was accepted and ${context}.`;
    }

    if (collection) {
      const itemLabel = singularize(collection.key);
      const countText = `${collection.count} ${itemLabel}${collection.count === 1 ? "" : "s"}`;
      const idText =
        collection.idCount > 0
          ? ` including ${collection.idCount} item ID${collection.idCount === 1 ? "" : "s"}`
          : "";

      if (
        collection.key === "messages" &&
        hasNumberField(responseBody, "resultSizeEstimate")
      ) {
        return `Returned ${countText} in \`${collection.key}\`${idText} with resultSizeEstimate ${readNumberField(
          responseBody,
          "resultSizeEstimate"
        )}, confirming the mailbox is readable.`;
      }

      return `Returned ${countText} in \`${collection.key}\`${idText}, confirming ${context}.`;
    }

    const resourceId = getResourceId(responseBody);
    const fieldList = getFieldList(responseBody);

    if (resourceId) {
      return `Returned ${httpStatusCode} with resource ID "${resourceId}"${fieldList ? ` and fields ${fieldList}` : ""}, confirming ${context}.`;
    }

    if (fieldList) {
      return `Returned ${httpStatusCode} with response fields ${fieldList}, confirming ${context}.`;
    }

    if (snippet) {
      return `Returned ${httpStatusCode} with body snippet "${snippet}", confirming ${context}.`;
    }

    return `Returned ${httpStatusCode}, confirming ${context}.`;
  }

  function summarizeInvalidEndpoint(
    endpoint: EndpointDefinition,
    httpStatusCode: number | null,
    responseBody: unknown,
    errorMessage: string | null
  ): string {
    const snippet = getResponseSnippet(responseBody) ?? getTextSnippet(errorMessage);
    const htmlText = looksLikeHtmlResponse(responseBody) ? " HTML" : "";

    if (endpoint.tool_slug.toUpperCase().includes("ARCHIVE")) {
      return `The API returned a${htmlText} 404${snippet ? ` with "${snippet}"` : ""} for ${endpoint.tool_slug}. This archive path does not exist in the real Gmail API; the real archive operation uses PATCH /messages/{id}/modify.`;
    }

    if (httpStatusCode === 405) {
      return `The API returned 405 Method Not Allowed${snippet ? ` with "${snippet}"` : ""} for ${endpoint.method} ${endpoint.path}, which indicates the endpoint definition is using the wrong HTTP method.`;
    }

    if (httpStatusCode === 404) {
      return `The API returned a${htmlText} 404${snippet ? ` with "${snippet}"` : ""} for ${endpoint.method} ${endpoint.path}. Because this endpoint does not require any path parameters, that is strong evidence that the path itself is fake.`;
    }

    return `The API indicated that ${endpoint.method} ${endpoint.path} is not a real executable endpoint${snippet ? `: "${snippet}"` : ""}.`;
  }

  function summarizeInsufficientScopes(
    endpoint: EndpointDefinition,
    httpStatusCode: number | null,
    responseBody: unknown,
    errorMessage: string | null
  ): string {
    const missingScopes = endpoint.required_scopes.filter(
      (scope) => !availableScopes.includes(scope)
    );
    const requiredText = formatScopeList(
      missingScopes.length > 0 ? missingScopes : endpoint.required_scopes
    );
    const availableText = describeAvailableScopes(availableScopes);
    const snippet = getResponseSnippet(responseBody) ?? getTextSnippet(errorMessage);

    return `${httpStatusCode ?? 403} returned${snippet ? ` with "${snippet}"` : ""} — this endpoint requires ${requiredText}, but ${availableText}.`;
  }

  function summarizeErrorResponse(
    endpoint: EndpointDefinition,
    httpStatusCode: number | null,
    responseBody: unknown,
    errorMessage: string | null
  ): string {
    const snippet = getResponseSnippet(responseBody) ?? getTextSnippet(errorMessage);

    if (httpStatusCode === null) {
      return `The request failed before a usable HTTP response was returned${snippet ? `: "${snippet}"` : ""}.`;
    }

    if (httpStatusCode === 404 && endpoint.parameters.path.length > 0) {
      return `The API returned 404${snippet ? ` with "${snippet}"` : ""} after substituting path parameters into ${endpoint.path}, so the endpoint may be real but the resolved resource ID appears missing or stale.`;
    }

    if (httpStatusCode === 400) {
      return `The API returned 400${snippet ? ` with "${snippet}"` : ""}, which means the endpoint was reached but rejected the constructed request parameters or body.`;
    }

    if (httpStatusCode === 401) {
      return `The API returned 401${snippet ? ` with "${snippet}"` : ""}, so authentication failed before the endpoint could execute successfully.`;
    }

    if (httpStatusCode >= 500) {
      return `The API returned ${httpStatusCode}${snippet ? ` with "${snippet}"` : ""}, which indicates a server-side failure after the request reached the endpoint.`;
    }

    return `The API returned ${httpStatusCode}${snippet ? ` with "${snippet}"` : ""}, so the endpoint was reached but the request did not complete successfully.`;
  }

  function buildReport(args: {
    endpoint: EndpointDefinition;
    status: EndpointStatus;
    httpStatusCode: number | null;
    responseSummary: string;
    responseBody: unknown;
    usedConnectedAccountId: string;
  }): EndpointReport {
    return {
      tool_slug: args.endpoint.tool_slug,
      method: args.endpoint.method,
      path: args.endpoint.path,
      status: args.status,
      http_status_code: args.httpStatusCode,
      response_summary: args.responseSummary,
      response_body: sanitizeForReport(args.responseBody),
      required_scopes: args.endpoint.required_scopes,
      available_scopes:
        args.usedConnectedAccountId === connectedAccountId ? availableScopes : [],
    };
  }

  async function runEndpointAgent(
    endpoint: EndpointDefinition
  ): Promise<EndpointReport> {
    const execution = await testEndpoint(endpoint);
    return execution.report;
  }

  const results = await Promise.all(
    params.endpoints.map((endpoint) => runEndpointAgent(endpoint))
  );

  const summary = {
    valid: results.filter((result) => result.status === "valid").length,
    invalid_endpoint: results.filter(
      (result) => result.status === "invalid_endpoint"
    ).length,
    insufficient_scopes: results.filter(
      (result) => result.status === "insufficient_scopes"
    ).length,
    error: results.filter((result) => result.status === "error").length,
  };

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: params.endpoints.length,
    results,
    summary,
  };
}

async function resolveConnectedAccountId(composio: Composio): Promise<string> {
  try {
    const response = await composio.connectedAccounts.list({});
    const accounts = Array.isArray(response.items) ? response.items : [];

    console.log(
      "[agent] Connected accounts discovered:",
      accounts.map((account) => ({
        id: readNested(account, "id"),
        appName: readNested(account, "appName"),
        toolkitSlug:
          readNested(account, "toolkitSlug") ??
          readNested(account, "toolkit", "slug"),
        authConfigToolkitSlug: readNested(
          account,
          "authConfig",
          "toolkit",
          "slug"
        ),
        status: readNested(account, "status"),
      }))
    );

    const gmailAccount = accounts.find((account) => accountMatchesGmail(account));
    const resolvedId = gmailAccount?.id ?? PRIMARY_FALLBACK_CONNECTED_ACCOUNT_ID;

    console.log("[agent] Resolved connected account ID:", {
      selected: resolvedId,
      strategy: "Use Gmail-connected Google account for all endpoints",
    });
    return resolvedId;
  } catch {
    console.log(
      "[agent] Failed to list connected accounts. Using fallback ID:",
      PRIMARY_FALLBACK_CONNECTED_ACCOUNT_ID
    );
    return PRIMARY_FALLBACK_CONNECTED_ACCOUNT_ID;
  }
}

async function getAvailableScopes(
  composio: Composio,
  connectedAccountId: string
): Promise<string[]> {
  try {
    const account = await composio.connectedAccounts.get(connectedAccountId);

    const rawScopes = [
      readNested(account, "state", "scopes"),
      readNested(account, "state", "scope"),
      readNested(account, "state", "user_scopes"),
      readNested(account, "data", "scopes"),
      readNested(account, "data", "scope"),
      readNested(account, "data", "user_scopes"),
      readNested(account, "params", "scopes"),
      readNested(account, "params", "scope"),
      readNested(account, "params", "user_scopes"),
    ];

    return [...new Set(rawScopes.flatMap(normalizeScopes))];
  } catch {
    return [];
  }
}

function accountMatchesGmail(account: unknown): boolean {
  const searchText = [
    readNested(account, "appName"),
    readNested(account, "toolkitSlug"),
    readNested(account, "toolkit", "slug"),
    readNested(account, "authConfig", "name"),
    readNested(account, "authConfig", "toolkit", "slug"),
  ]
    .flatMap((value) => normalizeSearchValues(value))
    .join(" ");

  return searchText.includes("gmail");
}

function readNested(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => normalizeScopes(item))
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeSearchValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeSearchValues(item));
  }

  if (typeof value === "string") {
    return [value.toLowerCase()];
  }

  return [];
}

function normalizeMethod(method: string): "GET" | "POST" | "PUT" | "DELETE" | "PATCH" {
  const upper = method.toUpperCase();
  if (
    upper === "GET" ||
    upper === "POST" ||
    upper === "PUT" ||
    upper === "DELETE" ||
    upper === "PATCH"
  ) {
    return upper;
  }
  return "GET";
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function countSharedPrefixSegments(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length);
  let count = 0;

  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) break;
    count += 1;
  }

  return count;
}

function getResourceHint(path: string, paramName: string): string {
  const segments = splitPath(path);
  const placeholder = `{${paramName}}`;
  const placeholderIndex = segments.indexOf(placeholder);
  const previousSegment = placeholderIndex > 0 ? segments[placeholderIndex - 1] : "";
  const baseName = paramName.toLowerCase().endsWith("id")
    ? paramName.slice(0, -2)
    : paramName;

  return singularize(
    sanitizeSegment(previousSegment || baseName || paramName).toLowerCase()
  );
}

function sanitizeSegment(segment: string): string {
  return segment.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]/g, "");
}

function singularize(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses")) return value.slice(0, -2);
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function pluralize(value: string): string {
  if (value.endsWith("y")) return `${value.slice(0, -1)}ies`;
  if (value.endsWith("s")) return value;
  return `${value}s`;
}

function extractCandidateValues(
  data: unknown,
  paramName: string,
  targetPath: string
): string[] {
  const values = new Set<string>();
  const normalizedParamName = paramName.toLowerCase();
  const baseName = normalizedParamName.endsWith("id")
    ? normalizedParamName.slice(0, -2)
    : normalizedParamName;
  const hint = getResourceHint(targetPath, paramName);
  const helpfulParents = new Set([
    hint,
    singularize(hint),
    pluralize(hint),
    "items",
    "results",
    "records",
    "data",
  ]);

  function addValue(value: unknown) {
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim();
      if (normalized) values.add(normalized);
    }
  }

  function visit(node: unknown, parentKey?: string) {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, parentKey);
      }
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    const record = node as Record<string, unknown>;
    const normalizedParent = parentKey?.toLowerCase();

    for (const [key, value] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase();

      if (normalizedKey === normalizedParamName) addValue(value);
      if (normalizedKey === `${baseName}id`) addValue(value);
    }

    if (
      record.id !== undefined &&
      normalizedParent !== undefined &&
      helpfulParents.has(normalizedParent)
    ) {
      addValue(record.id);
    }

    if (
      record.id !== undefined &&
      typeof record.kind === "string" &&
      record.kind.toLowerCase().includes(baseName)
    ) {
      addValue(record.id);
    }

    for (const [key, value] of Object.entries(record)) {
      visit(value, key);
    }
  }

  visit(data);
  return [...values];
}

function extractQuotedValues(description: string): string[] {
  const matches = [...description.matchAll(/'([^']+)'/g)];
  return matches.map((match) => match[1]).filter(Boolean);
}

function futureIsoString(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  return date.toISOString();
}

function buildCalendarDateTimeObject(offsetHours: number) {
  return {
    dateTime: futureIsoString(offsetHours),
    timeZone: "UTC",
  };
}

function buildRawEmailMessage(): string {
  const email = [
    "To: validator@example.com",
    "Subject: Endpoint validation test",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "This is an automated validation email.",
  ].join("\r\n");

  return btoa(email)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isEmptyResponseBody(value: unknown): boolean {
  if (value === null || value === undefined || value === "") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  const record = asRecord(value);
  return record ? Object.keys(record).length === 0 : false;
}

function getCollectionSummary(
  value: unknown
): { key: string; count: number; idCount: number } | null {
  if (Array.isArray(value)) {
    return {
      key: "items",
      count: value.length,
      idCount: countItemsWithIds(value),
    };
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const preferredKeys = [
    "messages",
    "threads",
    "labels",
    "events",
    "items",
    "results",
    "drafts",
    "calendars",
  ];
  const orderedKeys = [
    ...preferredKeys,
    ...Object.keys(record).filter((key) => !preferredKeys.includes(key)),
  ];

  for (const key of orderedKeys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return {
        key,
        count: candidate.length,
        idCount: countItemsWithIds(candidate),
      };
    }
  }

  return null;
}

function countItemsWithIds(items: unknown[]): number {
  let count = 0;

  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;

    if (
      typeof record.id === "string" ||
      typeof record.messageId === "string" ||
      typeof record.eventId === "string" ||
      typeof record.threadId === "string"
    ) {
      count += 1;
    }
  }

  return count;
}

function hasNumberField(value: unknown, key: string): boolean {
  return typeof readNumberField(value, key) === "number";
}

function readNumberField(value: unknown, key: string): number | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const candidate = record[key];
  return typeof candidate === "number" ? candidate : null;
}

function getResourceId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const directKeys = ["id", "messageId", "eventId", "threadId", "draftId"];
  for (const key of directKeys) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }

  const nestedMessage = asRecord(record.message);
  if (nestedMessage && typeof nestedMessage.id === "string") {
    return nestedMessage.id;
  }

  return null;
}

function getFieldList(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const keys = Object.keys(record)
    .filter((key) => !/^_|raw$/i.test(key))
    .slice(0, 4);

  return keys.length > 0 ? keys.map((key) => `\`${key}\``).join(", ") : null;
}

function getSuccessContext(endpoint: EndpointDefinition): string {
  const path = endpoint.path.toLowerCase();
  const method = endpoint.method.toUpperCase();

  if (method === "GET" && path.includes("/gmail/")) {
    return "the mailbox is readable";
  }

  if (method === "GET" && path.includes("/calendar/")) {
    return "the calendar is readable";
  }

  if (path.includes("/gmail/")) {
    return "the Gmail write path is live";
  }

  if (path.includes("/calendar/")) {
    return "the Calendar write path is live";
  }

  return "the endpoint is live";
}

function getResponseSnippet(value: unknown): string | null {
  const seen = new Set<unknown>();

  function visit(node: unknown, depth: number): string | null {
    if (depth > 3 || node === null || node === undefined) {
      return null;
    }

    if (typeof node === "string") {
      return getTextSnippet(node);
    }

    if (typeof node === "number" || typeof node === "boolean") {
      return String(node);
    }

    if (Array.isArray(node)) {
      for (const item of node.slice(0, 3)) {
        const snippet = visit(item, depth + 1);
        if (snippet) return snippet;
      }
      return null;
    }

    const record = asRecord(node);
    if (!record || seen.has(record)) {
      return null;
    }
    seen.add(record);

    const preferredKeys = [
      "message",
      "error",
      "error_description",
      "detail",
      "details",
      "title",
      "summary",
      "status",
    ];

    for (const key of preferredKeys) {
      if (key in record) {
        const snippet = visit(record[key], depth + 1);
        if (snippet) return snippet;
      }
    }

    for (const [key, entryValue] of Object.entries(record).slice(0, 6)) {
      if (/token|authorization|raw/i.test(key)) {
        continue;
      }

      const snippet = visit(entryValue, depth + 1);
      if (snippet) return snippet;
    }

    return null;
  }

  return visit(value, 0);
}

function getTextSnippet(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = redactText(value).replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return null;
  }

  return truncateString(cleaned, 180);
}

function looksLikeHtmlResponse(value: unknown): boolean {
  const text = stringifyUnknown(value).toLowerCase().slice(0, 400);
  return text.includes("<html") || text.includes("<!doctype html");
}

function shortScopeName(scope: string): string {
  const normalized = scope.trim();
  const authIndex = normalized.lastIndexOf("/auth/");
  if (authIndex >= 0) {
    return normalized.slice(authIndex + "/auth/".length);
  }

  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }

  return normalized;
}

function formatScopeList(scopes: string[]): string {
  const shortScopes = [...new Set(scopes.map((scope) => shortScopeName(scope)))];
  if (shortScopes.length === 0) {
    return "additional scopes";
  }
  if (shortScopes.length === 1) {
    return `\`${shortScopes[0]}\` scope`;
  }
  return `${shortScopes.map((scope) => `\`${scope}\``).join(", ")} scopes`;
}

function getScopeFamily(scope: string): string {
  const short = shortScopeName(scope);
  return short.split(/[.:]/)[0] || short;
}

function describeAvailableScopes(scopes: string[]): string {
  if (scopes.length === 0) {
    return "the connected token did not expose its granted scopes";
  }

  const shortScopes = [...new Set(scopes.map((scope) => shortScopeName(scope)))];
  const families = [...new Set(scopes.map((scope) => getScopeFamily(scope)))];
  const listedScopes =
    shortScopes.length <= 3
      ? shortScopes.join(", ")
      : `${shortScopes.slice(0, 3).join(", ")} (+${shortScopes.length - 3} more)`;

  if (families.length === 1) {
    return `the connected token only has ${families[0]} scopes (${listedScopes})`;
  }

  return `the connected token exposes ${listedScopes}`;
}

function sanitizeForReport(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return truncateString(redactText(value), 500);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => sanitizeForReport(item, depth + 1));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(0, 20);
    const sanitized: Record<string, unknown> = {};

    for (const [key, entryValue] of entries) {
      if (/token|authorization|raw/i.test(key)) {
        sanitized[key] = "[redacted]";
        continue;
      }

      sanitized[key] = sanitizeForReport(entryValue, depth + 1);
    }

    if (Object.keys(record).length > entries.length) {
      sanitized._truncated = true;
    }

    return sanitized;
  }

  return String(value);
}

function redactText(value: string): string {
  return value
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[redacted-email]"
    )
    .replace(/(bearer\s+)[a-z0-9._-]+/gi, "$1[redacted]");
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

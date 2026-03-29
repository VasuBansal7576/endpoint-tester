# Architecture

## 1. Design Overview

I implemented the validator as a deterministic orchestrator that spins up one endpoint agent per endpoint. Each endpoint agent is an independent async worker, and all of them are launched concurrently with `Promise.all(...)`. At startup, the orchestrator queries Composio for connected accounts, logs what it finds for debugging, selects the Gmail-connected Google account, and uses that connected account ID for all endpoint execution. This was the most reliable strategy in practice because the Gmail OAuth connection represented the real Google account, while the separate Calendar connection was returning broken 404s.

The runtime flow is:

1. Read connected accounts from Composio and resolve the primary connected account ID.
2. Fetch available scopes for that connected account once.
3. Launch one endpoint agent per endpoint concurrently.
4. For each endpoint, resolve any path parameters first.
5. Build query params and request body dynamically from the schema.
6. Execute the endpoint through `composio.tools.proxyExecute(...)`.
7. Classify the result and append an `EndpointReport`.
8. Return the final `TestReport` with summary counts.

The shared execution cache is still central to the design. If endpoint agent A depends on endpoint B while B is already running or has already completed, A reuses the cached promise/result instead of re-running it. That gives me concurrent endpoint agents without duplicate execution.

## 2. Dependency Resolution

For endpoints with path params such as `{messageId}` or `{eventId}`, the agent uses a scoring-based candidate finder to discover the best upstream endpoint that can produce that ID.

The strategy is:

1. Look for endpoints with fewer path params than the target endpoint.
2. Prefer endpoints with the same path prefix.
3. Prefer `GET` list/search endpoints over other methods.
4. Give additional score to endpoints whose path or description matches the resource name.

This usually makes a list endpoint win before a detail endpoint. For example:

- `GMAIL_GET_MESSAGE` prefers `GMAIL_LIST_MESSAGES`
- `GOOGLECALENDAR_GET_EVENT` prefers `GOOGLECALENDAR_LIST_EVENTS`

Once a candidate endpoint is selected, the agent executes it first and recursively searches its response body for likely IDs. The extractor walks nested arrays and objects, checks keys like `id`, `messageId`, `eventId`, and also uses parent collection names like `messages`, `events`, `items`, and `results` to decide whether an `id` belongs to the target resource.

If a usable ID is found, it is substituted into the path and the dependent endpoint is executed.

If dependency resolution fails because the producer endpoint returned `insufficient_scopes`, that status is propagated downstream. This avoids reporting a dependent detail/delete endpoint as a generic error when the real problem is simply that the account lacks permission to fetch the prerequisite resource list.

## 3. Avoiding False Negatives

The main goal was to avoid blaming a real endpoint for my own bad request construction.

I used a few guardrails for that:

- Query params are constructed conservatively. The agent only sends required params plus a few safe optional params such as `maxResults`, `limit`, `format`, or `showHidden`.
- Request bodies are built dynamically from the schema rather than hardcoded per endpoint.
- For Gmail write endpoints, the agent generates a minimal RFC 2822 email and base64url-encodes it for `raw`.
- For Calendar endpoints, the agent generates RFC3339 timestamps and builds minimal `start` / `end` objects.
- For detail endpoints with path params, the agent tries to discover a real ID instead of inventing one.
- Response bodies are sanitized and truncated in the report so the output remains usable and safe.

Another important false-negative safeguard is in 404 handling:

- A 404 on an endpoint with no path params is treated as evidence that the endpoint path/method is fake.
- A 404 on an endpoint with path params is usually treated as a bad or stale resource ID, not proof that the endpoint is invalid.
- The one explicit exception is any slug containing `ARCHIVE`. In this assignment, the Gmail archive path is not a real endpoint, so a 404 there is classified as `invalid_endpoint`.

This distinction prevented valid detail endpoints from being mislabeled just because dependency resolution produced a missing resource.

## 4. Classification Logic

The classifier is intentionally simple and deterministic:

- `2xx` -> `valid`
- `403` or permission/scope text -> `insufficient_scopes`
- `404` on an endpoint with no path params -> `invalid_endpoint`
- `404` on an endpoint with path params -> `error`
- `404` on an `ARCHIVE` slug -> `invalid_endpoint`
- `405` or explicit “method not allowed / unknown endpoint / no route” text -> `invalid_endpoint`
- `null` HTTP status -> `error`
- everything else -> `error`

This means:

- fake collection endpoints such as nonexistent Gmail or Calendar paths become `invalid_endpoint`
- real Calendar endpoints hit with the Gmail token become `insufficient_scopes`
- dependent Calendar detail/delete endpoints also become `insufficient_scopes` if their prerequisite list endpoint failed for scope reasons

## 5. Tradeoffs

I chose concurrent endpoint agents with a shared cache instead of a single sequential loop.

Pros:

- matches the assignment requirement of one agent per endpoint
- faster wall-clock time than a fully sequential executor
- dependency order is explicit and easy to reason about
- logs are easy to follow
- shared resource IDs are easier to manage
- fewer race conditions on destructive endpoints

Cons:

- more moving parts than a purely sequential loop
- concurrent agents can still contend for shared IDs if heuristics are weak
- less throughput if the endpoint set becomes very large

I also chose a single connected-account strategy for execution. In theory, app-specific routing is cleaner. In practice for this assignment, using the Gmail-connected Google OAuth token for all Google endpoints was more reliable than trying to route Calendar calls through a separate broken Calendar connection.

With more time, I would improve:

- smarter handling for create-then-cleanup flows when list endpoints are empty
- richer structured reasoning for classifying ambiguous 4xx responses
- stronger resource-isolation for destructive endpoints
- more explicit destructive-operation safeguards

## 6. Architecture Pattern

I chose a deterministic multi-worker pattern: one endpoint agent per endpoint, coordinated by a single in-process orchestrator and no LLM calls.

Why this pattern:

- fast to implement in a 90-minute assignment
- predictable behavior
- easy to debug
- easy to explain in a review or Loom walkthrough
- general enough to work across apps without hardcoding Gmail- or Calendar-only logic for the core request-building path

Pros:

- simple control flow
- reproducible results
- low latency overhead
- aligned with the architecture requirement in the prompt
- easy to extend with more heuristics

Cons:

- no natural-language reasoning for weird edge cases
- less adaptive than a true planner/executor architecture
- cache coordination is slightly more complex than a plain sequential loop

For this assignment, I think this was the right tradeoff: small deterministic endpoint agents running concurrently, coordinated through a shared cache, with the complexity kept in request construction and dependency handling rather than in LLM-style planning.

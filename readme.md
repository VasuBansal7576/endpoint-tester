# API Endpoint Validation Agent

This project validates API endpoints through Composio. It tests the provided Gmail and Google Calendar endpoint definitions, executes each endpoint against a connected Google account, and classifies the result as one of:

- `valid`
- `invalid_endpoint`
- `insufficient_scopes`
- `error`

The output is a structured `TestReport` written to `report.json`.

## How It Works

- One agent runs per endpoint
- All endpoint agents execute concurrently
- Dependencies are resolved dynamically for path params like `{messageId}` or `{eventId}`
- Request query params and bodies are built from the endpoint schema definitions
- A shared execution cache avoids duplicate dependency calls across agents

## Run

```bash
COMPOSIO_API_KEY=your_key sh setup.sh
bun src/run.ts
```

## Results

Running the agent generates `report.json`, which contains the full classification report for every endpoint, including:

- status
- HTTP status code
- response summary
- response body
- required scopes
- available scopes

## Architecture

See [ARCHITECTURE.md](/Users/vasu/Downloads/endpoint-tester/ARCHITECTURE.md) for the full design and implementation details.

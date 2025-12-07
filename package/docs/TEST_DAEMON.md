# Test Daemon

A persistent Meteor test server that enables fast, on-demand test execution without the ~90 second startup time on each run.

## Quick Start

```bash
# Run tests (auto-starts daemon if needed)
./scripts/test-run

# Run tests matching a pattern
./scripts/test-run Calendar

# Run tests in a specific file
./scripts/test-run imports/api/calendar/FullSync.app-spec.ts

# Daemon management
./scripts/test-run daemon start
./scripts/test-run daemon stop
./scripts/test-run daemon status
./scripts/test-run daemon restart
```

## How It Works

The daemon keeps a Meteor test instance running persistently, with all test suites pre-loaded. When you request a test run:

1. The CLI sends a request to the daemon's HTTP API
2. The daemon resets Mocha's test state (clearing previous results)
3. Tests are filtered by grep pattern and/or file path
4. Results stream back via Server-Sent Events (SSE)
5. The CLI displays output and exits with appropriate code

This avoids the ~90 second cold start for each test run.

## CLI Reference

### Basic Usage

```bash
./scripts/test-run [options] [pattern|filepath...]
./scripts/test-run daemon [start|stop|status|restart]
```

### Options

| Option | Description |
|--------|-------------|
| `-t, --testNamePattern <pattern>` | Filter by test name (can repeat for OR logic) |
| `-g, --grep <pattern>` | Alias for `-t` |
| `-f, --file <path>` | Run tests in specific file |
| `-i, --invert` | Invert pattern match (exclude instead of include) |
| `-h, --help` | Show help |

### Examples

```bash
# Run all tests
./scripts/test-run

# Match single pattern
./scripts/test-run Calendar

# Multiple patterns (OR logic)
./scripts/test-run -t Calendar -t sync

# Exclude pattern
./scripts/test-run Calendar -i

# Run specific file (full path)
./scripts/test-run imports/api/calendar/FullSync.app-spec.ts

# Run specific file (partial path)
./scripts/test-run -f FullSync.app-spec.ts

# File + grep filter
./scripts/test-run FullSync.app-spec.ts -t "clears data"
```

### File Path Detection

The CLI auto-detects file paths by looking for test file patterns:
- `.app-spec.`
- `.app-test.`
- `.spec.`
- `.test.`

If an argument contains any of these patterns, it's treated as a file path filter rather than a grep pattern.

## HTTP API

The daemon exposes these endpoints on port 9100 (configurable via `TEST_PORT` env var):

### GET /test/health

Health check endpoint.

**Response:**
```json
{
  "status": "ready",
  "suites": 62,
  "running": false
}
```

### GET /test/files

Returns a mapping of file paths to their test suite titles.

**Response:**
```json
{
  "imports/api/actions/server/create.app-spec.ts": [
    "actions.create",
    "actions.create with scheduling"
  ],
  "server/api.app-spec.js": [
    "API",
    "API addAction"
  ]
}
```

### GET /test/run

Runs tests with optional filtering. Returns Server-Sent Events stream.

**Query Parameters:**

| Param | Description |
|-------|-------------|
| `grep` | Regex pattern to match test names |
| `file` | File path pattern to filter by |
| `invert` | Set to `1` to invert the grep match |

**Example:**
```bash
curl "http://localhost:9100/test/run?grep=Calendar&invert=0"
```

**SSE Events:**

```
data: {"type": "start", "grep": "Calendar", "invert": false}

data: {"type": "log", "data": "  ✓ creates calendar connection"}

data: {"type": "error", "data": "  ✗ fails on invalid token"}

data: {"type": "done", "failures": 1}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_PORT` | `9100` | Port for daemon HTTP server |
| `TEST_DAEMON` | - | Set to any value to enable daemon mode |

## File Tracking

The daemon tracks which file each test suite comes from by wrapping `describe()` to capture stack traces at registration time. This enables:

- Running tests by file path
- The `/test/files` endpoint
- Better error attribution

**Supported patterns:**
- `*.app-spec.ts`
- `*.app-test.ts`
- `*.spec.ts`
- `*.test.ts`
- `*.app-spec.js`
- `*.app-test.js`
- `*.spec.js`
- `*.test.js`

## Limitations

1. **Server tests only** - The daemon runs with `TEST_CLIENT=0`. Client-side tests (those in `client/` folders) are not available via the daemon because they require a browser.

2. **Hot reload** - The daemon runs Meteor in watch mode, so code changes are picked up automatically. When you save a file, Meteor rebuilds and the daemon restarts with the new code. No manual restart needed.

3. **Shared state** - Tests share the same Meteor/MongoDB instance. Use `resetDatabase()` in `beforeEach()` to ensure isolation.

## Daemon Management

### Lock File

The daemon uses a lock file (`.meteor/local/test-daemon.lock`) to prevent multiple instances from starting simultaneously. If the lock becomes stale (>3 minutes old or owner process dead), it's automatically cleaned up.

### PID File

The daemon's process ID is stored in `.meteor/local/test-daemon.pid`. This enables:
- Clean shutdown via `daemon stop`
- Process group termination (kills child processes)

### Log File

Daemon output is written to `.meteor/local/test-daemon.log`. Check this if the daemon fails to start.

## Troubleshooting

### Daemon won't start

1. Check if something is using port 9100:
   ```bash
   lsof -i:9100
   ```

2. Check the log file:
   ```bash
   cat .meteor/local/test-daemon.log
   ```

3. Clean up stale files and restart:
   ```bash
   rm .meteor/local/test-daemon.pid .meteor/local/test-daemon.lock
   ./scripts/test-run daemon start
   ```

### Tests not found for file

1. Verify the file path is in the mapping:
   ```bash
   curl -s http://localhost:9100/test/files | jq 'keys | .[]' | grep -i yourfile
   ```

2. If missing, the file may be a client-side test (not supported) or the daemon needs restart.

### Stale test results

Restart the daemon after code changes:
```bash
./scripts/test-run daemon restart
```

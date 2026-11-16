# Contribution Guidelines

These guidelines apply to the entire `dupe` repository. Each rule protects the behavior and execution context of its target layer.

## Review approach

Balance correctness, cleanliness, and simplicity. A working implementation warrants a finding when its design creates maintenance costs or avoidable complexity.

### Review perspective

Understand the intended behavior and inspect surrounding callers to assess the implementation in context. Step back from individual lines to verify that the approach fits the system requirements.

Ask what a maintainer must understand to make the next change, and how many files they must touch.

- **Correctness:** Check behavior, edge cases, failure paths, and schema compatibility. Follow assumptions across API callers and frontend components.
- **Complexity:** Question unnecessary indirection, branching, configuration, state, and abstractions. Look for a simpler implementation that preserves required behavior.
- **Responsibilities and boundaries:** Give each file and module a single coherent responsibility. Keep dependencies one-directional across backend, scripts, and frontend layers.
- **Repetition:** Consolidate duplicated business rules and SQL or API contracts that must stay synchronized. Allow small repetition when abstraction adds coupling.
- **Comments and docstrings:** Delete stale or redundant explanations. State only contracts, invariants, and reasons that the code cannot express directly.
- **Dead code:** Remove unused functions, parameters, configuration keys, and CLI flags. Inspect callers across the repository before removing shared symbols.
- **Inline imports:** Place imports at the top of the file. Use lazy imports only for heavy browser WASM bundles or optional runtime dependencies.
- **Hidden contracts:** Make data shapes, coordinate normalization, and authentication requirements explicit in types and schemas.
- **Failure semantics:** Validate required inputs at system boundaries and fail closed with clear error messages. Avoid silent fallbacks that hide corrupt state.

### Test judgment

Assess the specific behavior or regression that each test protects. A concise test can protect a critical contract.

Avoid redundant cases, trivial assertions, excessive mocking, and tests coupled to private implementation details. Cover failure paths for metadata extraction, authentication, and database writes.

Tests must assert behavior independently of the production algorithm. Preserve behavioral contracts across refactors.

### Findings

Report concrete, actionable concerns. Identify the code, explain the failure mode or maintenance cost, and suggest a proportionate fix.

Distinguish correctness defects, design concerns, and optional suggestions. Explain the practical cost of every design finding.

Verify that a rule applies and check whether an existing boundary already establishes the invariant before reporting a finding.

Keep recommendations scoped to the change. Consolidate findings that share an underlying cause. State verification gaps explicitly.

## Principles

This repository powers a self-hosted academic research and paper-writing studio on a constrained home Linux server. The engineering principles reflect these hardware and workflow constraints:

- **Hope is not a strategy.** Verify every change with a test, a query check, or an end-to-end compilation run. Untested behavior is unspecified behavior.
- **Client-side offload is a correctness property.** The home server runs on a 2015 Intel Core i7 CPU with 300 GB of disk. Heavy tasks run in the user's browser.
- **Data schemas are long-lived contracts.** Every table uses client-generated UUID keys, `updated_at` timestamps, and `deleted_at` soft-deletes. Schema changes must preserve offline sync compatibility.
- **Resources are budgeted.** The server handles authentication, PostgreSQL CRUD, file storage, and bounded Python metadata scraping. It never compiles LaTeX or renders PDFs.
- **Failures must be observable.** Subprocesses, database queries, and Web Worker compilers must emit structured errors that identify the failing step and input.
- **Simple and boring beats clever.** Prefer standard library HTTP routing, explicit SQL queries, and straightforward React state over deep framework hierarchies.
- **Reversibility matters.** Database migrations, storage layouts, and BibTeX generation rules must support clean rollback without data loss.

## Code quality

- Use explicit static types in Go and TypeScript, and type annotations in Python scripts. Validate external inputs at HTTP, CLI, and worker boundaries.
- Handle errors where the component can add context or recover cleanly. Return structured HTTP error responses with appropriate status codes.
- Keep API payloads and database return shapes stable and explicit. Update all frontend and extension callers when changing an endpoint contract.
- Fail closed on missing required inputs, invalid JWT tokens, corrupt PDF uploads, or missing configuration variables.
- Expose deployment values such as port bindings, storage paths, and JWT secrets through environment variables or CLI flags. Keep fixed algorithmic constants in code.
- Respect module boundaries. Frontend components communicate with the backend exclusively through the typed client in `web/src/api/`.
- Never commit secrets, JWT signing keys, password hashes, or private user PDFs.

## Execution tiers and resource budgets

Classify every piece of code by where it executes and apply the corresponding resource rules:

- **Tier 0: Browser UI main thread** (`web/src/components/`). Maintains 60 fps interaction for split-pane resizing, CodeMirror 6 editing, and Excalidraw drawing. Never run synchronous compilation, full-document parsing, or blocking I/O on the main thread.
- **Tier 1: Browser Web Workers** (`web/src/workers/`). Executes WASM LaTeX and Typst compilation, virtual `.bib` assembly, and heavy PDF page rendering off the main thread.
- **Tier 2: Go HTTP server and PostgreSQL** (`backend/`). Listens on `127.0.0.1:8080` and serves JSON APIs and static assets or PDF streams with minimal memory overhead.
- **Tier 3: Background CLI, Git, and metadata scripts** (`scripts/`, `backend/handlers_git.go`). Runs Python DOI and BibTeX extraction and `git` synchronization commands via `os/exec` under strict context timeouts.

**Storage deduplication.** The Go server hashes uploaded PDFs with SHA-256 and stores each unique file once under `storage/pdfs/` to conserve the 300 GB disk budget.

**Normalized coordinates.** PDF highlight overlays store bounding boxes as page-normalized coordinates between `0.0` and `1.0`. Code never persists device pixel coordinates to the database.

**Bounded subprocesses.** Every `os/exec` invocation from Go attaches a `context.WithTimeout` deadline and captures `stderr` for diagnostics.

## Architecture boundaries

Keep dependencies one-directional across top-level directories:

- `backend/` owns the Go HTTP server, JWT authentication, PostgreSQL connection pool, and `schema.sql`.
- `scripts/` owns standalone Python utilities invoked by `backend/` to extract PDF metadata and resolve DOIs from Crossref and arXiv.
- `web/` owns the Vite, React, and TypeScript workspace, including the PDF reader, BibTeX library, CodeMirror 6 LaTeX editor, Excalidraw canvas, and WASM compilation workers.
- `extension/` owns the Manifest V3 Chrome Web Clipper.
- `storage/` holds local runtime PDF files and stays out of version control.

## Review checklist

- Verify that new database tables or columns include `UUID` keys, `updated_at`, and `deleted_at` where sync applies.
- Confirm that heavy text processing, typesetting, and rendering execute in the browser or inside a Web Worker.
- Check that all frontend API requests use relative paths (`/api/...`) so `tailscale serve` and `cloudflared` proxies work without reconfiguration.
- Ensure that SQL queries parameterize all user inputs and enforce `owner_id` or `is_shared` access controls.
- Confirm that `scripts/extract_meta.py` degrades gracefully to PDF text heuristics when network DOI lookups time out or fail.
- Check that BibTeX keys follow a deterministic formatting convention and handle missing metadata fields without crashing.

## Configuration and environment

- Read environment-specific values (`DATABASE_URL`, `JWT_SECRET`, `STORAGE_DIR`, `PORT`) at server startup and fail immediately if required settings are missing.
- Keep `docker-compose.yml` and `.air.toml` self-contained so local development starts with standard commands.
- Ensure unit and integration tests run locally without external network reliance by mocking Crossref and arXiv HTTP calls in tests.

## Dependencies

- `backend/go.mod` and `backend/go.sum` lock Go dependencies. Run `go mod tidy` after any dependency change.
- `scripts/requirements.txt` pins Python packages (`PyMuPDF`, `requests`, `bibtexparser`).
- `web/package.json` and its lockfile pin frontend packages. Commit lockfile updates in the same change as `package.json`.

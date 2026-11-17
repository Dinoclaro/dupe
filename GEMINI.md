# GEMINI.md

Entry point for coding agents in `dupe` (Dino's Ultimate Paper Editor). Read this file first, then read [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTION.md](CONTRIBUTION.md) once per session.

## What this repository is

`dupe` is an academic research and paper-writing workspace. It combines a PDF library, a BibTeX generator, a WASM LaTeX/Typst compiler, a diagram tool, and Markdown notes in a split-pane web application.

Each project is a folder on disk with `paper/`, `code/`, `notes/`, `diagrams/`, and `refs/`. VS Code edits the code. dupe handles reading, writing, citations, and diagrams. Coding agents read the same folder.

The Go binary runs in two modes. Local mode runs on a laptop and works offline. Hosted mode runs on a home Linux server (2015 Intel Core i7, 300 GB storage). It owns the paper library and serves friends. Heavy computation runs in the browser.

## Where to read next

| Path | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, database schema, directory structure, and MVP roadmap |
| [CONTRIBUTION.md](CONTRIBUTION.md) | Code quality, execution tiers, resource budgets, and review rules |

## Minimal Viable Product (MVP) priority

The library, BibTeX pipeline, Overleaf bridge, LaTeX editor, and diagram tool exist. Build the next features in this order. [ARCHITECTURE.md](ARCHITECTURE.md) section 11 has the details.

1. **Project folders and local mode (`backend/`, `web/`):** Add the `--mode` flag and the project folder format. A "New project" action creates the folder layout. Users link Overleaf repositories in the project settings. The explorer shows the project tree. Notes go to `notes/` and diagrams go to `diagrams/`. Generate `AGENTS.md`, `references.bib`, and `refs/text/` in each project.
2. **Library sync (`backend/`, `web/`):** Add the sync API, the local outbox, the PDF cache, and the TeX package cache for offline use.
3. **Agent integration (`backend/`):** Add the `dupe mcp` server with library tools.
4. **Hosted mode for friends (`backend/`, `deploy/`):** Disable the terminal in hosted mode and restrict WebSocket origins. Add per-user project folders, `cloudflared` with Cloudflare Access, and backup jobs.
5. **Hosted agent panel (`backend/`, `web/`):** Run read-only agents in containers with user-supplied API keys. Show their edits as diffs.
6. **Post-MVP (`web/`, `extension/`):** Add highlights and backlinks, the Chrome Web Clipper, and the iPad offline PWA.

## Checks

- Run `go test ./...` and `go vet ./...` inside `backend/` after editing Go files.
- Run `npm run build` (or `tsc --noEmit`) and `npm test` inside `web/` after editing frontend files.
- Test `python3 scripts/extract_meta.py` against sample PDFs after editing Python scripts.
- Complete edits and formatting before final validation. Use targeted checks during development and run all relevant checks before handoff.
- Reuse successful checks within the session while their source files, configuration, and dependencies remain unchanged.

## Writing

These rules apply to all prose you write or edit, in any language and any folder: comments, docstrings, Markdown, READMEs, commit messages, and PR descriptions. They follow ASD-STE100 (Simplified Technical English). Code, quoted text, and command output keep their own form.

- Delete first. A comment stays only if it states a contract or a reason the code cannot show. A comment that stays is one line.
- Use the active voice and name the actor: "The server rejects expired tokens."
- Write one fact per sentence. A comment has at most 20 words. Any other sentence has at most 25.
- Use a verb for an action ("validates the schema") and one-word verbs ("starts", "removes").
- Stack at most three nouns. Use one word for one meaning across a file.
- Keep modality. "May fail" and "fails" are different claims.
- State what a thing is and does. Delete contrasts: "X, not Y", "instead of", "rather than".
- State the fact and stop. Delete "so", "therefore", "which means" and labels such as "the key insight is".
- Describe the present. Change history belongs in the commit message and the PR description.
- Keep text self-contained. Never refer to a chat, a prompt, a plan file, or a local path.
- Use plain, literal words. No hype, idiom, metaphor, em dash, semicolon, emoji, or ASCII banner. The AI attribution below is the only emoji exception.

## Commits and pull requests

- Use conventional commits: `<type>(<scope>): <subject>`, for example `feat(backend): extract bibtex metadata on pdf upload`. The scope is the top-level folder (`backend`, `scripts`, `web`, `extension`). Join several with commas: `feat(backend,web): ...`.
- Never commit secrets, `.env` files, or private PDFs in `storage/`.

## AI attribution

End each agent-authored PR description, review, review comment, issue description, and issue comment with the Markdown suffix `*Unfiltered AI output* 🤖`. Commit messages and PR titles take no signature.

## Agent files

- `GEMINI.md` and `AGENTS.md` hold the instructions for coding agents in this repository. Keep both synchronized when updating repo-wide agent rules.

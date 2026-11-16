# AGENTS.md

Entry point for coding agents in `dupe` (Dino's Ultimate Paper Editor). Read this file first, then read [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTION.md](CONTRIBUTION.md) once per session.

## What this repository is

`dupe` is a self-hosted academic research and paper-writing workspace that runs on a home Linux server (2015 Intel Core i7, 300 GB storage). It combines a PDF library, automatic BibTeX generator, client-side WASM LaTeX/Typst compiler, Excalidraw diagram tool, and Markdown note-taker in a split-pane desktop web application.

Heavy computation runs in the user's browser (`PDF.js`, `CodeMirror 6`, `Excalidraw`, and WASM LaTeX/Typst inside Web Workers). The Go backend handles authentication, PostgreSQL CRUD, SHA-256 deduplicated PDF storage, and bounded Python metadata extraction.

## Where to read next

| Path | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, database schema, directory structure, and MVP roadmap |
| [CONTRIBUTION.md](CONTRIBUTION.md) | Code quality, execution tiers, resource budgets, and review rules |

## Minimal Viable Product (MVP) priority

Prioritize features in the order required to write an academic paper end-to-end with Overleaf and GitHub:

1. **Paper Library and BibTeX Pipeline (`backend/`, `scripts/`):** Store all uploaded PDFs with SHA-256 deduplication, extract DOIs and metadata via Python (`PyMuPDF` + Crossref/arXiv), and generate clean BibTeX entries for every paper.
2. **Overleaf-GitHub Repository Bridge (`backend/`):** Clone an Overleaf-linked GitHub repository into `storage/repos/`, write the generated `references.bib` and exported figures into the repository, and commit/push changes back to GitHub.
3. **Diagram Tool, LaTeX Editor, and Preview (`web/`):** Embed an `Excalidraw` canvas to export diagrams into the linked GitHub repo (`figures/`), edit `.tex` files in `CodeMirror 6` with `@citation` autocomplete backed by the `.bib` library, and preview with `PDF.js` and the Web Worker WASM LaTeX engine.
4. **Post-MVP (`web/`, `extension/`):** Add the Markdown note-taker, PDF highlight overlays with bidirectional backlinks, Chrome Web Clipper, and Phase 5 iPad offline sync.

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

#!/usr/bin/env python3
"""Extracts academic metadata and BibTeX entries from PDF files."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import sys
from typing import Any
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None  # type: ignore[assignment]

DOI_PATTERN = re.compile(r"\b(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)\b")
ARXIV_PATTERN = re.compile(r"arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)", re.IGNORECASE)
YEAR_PATTERN = re.compile(r"\b(19\d{2}|20\d{2})\b")
STOPWORDS = frozenset({"a", "an", "and", "for", "in", "of", "on", "the", "to", "with", "via"})
HTTP_TIMEOUT_SECONDS = 5.0
USER_AGENT = "dupe-metadata-extractor/1.0 (mailto:admin@localhost)"


@dataclass(frozen=True)
class PaperMetadata:
    title: str
    authors: str
    publication_year: int | None
    doi: str
    bibtex_key: str
    bibtex_raw: str


def clean_doi(raw_doi: str) -> str:
    return raw_doi.rstrip(".,;)]}>\"'")


def extract_pdf_text_and_info(pdf_path: Path, max_pages: int = 3) -> tuple[dict[str, str], str, str]:
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) is required to read PDF files.")
    doc = fitz.open(pdf_path)
    try:
        info = {k: str(v).strip() for k, v in (doc.metadata or {}).items() if v}
        pages_text: list[str] = []
        largest_title = ""
        largest_size = 0.0

        page_limit = min(len(doc), max_pages)
        for idx in range(page_limit):
            page = doc[idx]
            pages_text.append(page.get_text("text"))
            if idx == 0:
                blocks = page.get_text("dict").get("blocks", [])
                for block in blocks:
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            text = str(span.get("text", "")).strip()
                            size = float(span.get("size", 0.0))
                            if len(text) > 5 and size > largest_size:
                                largest_size = size
                                largest_title = text

        return info, "\n".join(pages_text), largest_title
    finally:
        doc.close()


def find_identifiers(info: dict[str, str], text: str) -> tuple[str, str]:
    combined = " ".join([info.get("subject", ""), info.get("keywords", ""), info.get("doi", ""), text])
    doi_match = DOI_PATTERN.search(combined)
    doi = clean_doi(doi_match.group(1)) if doi_match else ""
    arxiv_match = ARXIV_PATTERN.search(combined)
    arxiv_id = arxiv_match.group(1) if arxiv_match else ""
    return doi, arxiv_id


def fetch_crossref(doi: str, timeout: float = HTTP_TIMEOUT_SECONDS) -> dict[str, Any] | None:
    encoded = urllib.parse.quote(doi, safe="")
    url = f"https://api.crossref.org/works/{encoded}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    message = payload.get("message", {})
    titles = message.get("title") or []
    title = str(titles[0]).strip() if titles else ""
    authors_list: list[str] = []
    for author in message.get("author", []):
        given = str(author.get("given", "")).strip()
        family = str(author.get("family", "")).strip()
        full = f"{given} {family}".strip()
        if full:
            authors_list.append(full)

    year: int | None = None
    for date_field in ("published-print", "published-online", "issued", "created"):
        parts = message.get(date_field, {}).get("date-parts", [])
        if parts and parts[0] and isinstance(parts[0][0], int):
            year = parts[0][0]
            break

    container = message.get("container-title") or []
    venue = str(container[0]).strip() if container else ""
    return {
        "title": title,
        "authors": ", ".join(authors_list),
        "publication_year": year,
        "doi": doi,
        "venue": venue,
    }


def fetch_arxiv(arxiv_id: str, timeout: float = HTTP_TIMEOUT_SECONDS) -> dict[str, Any] | None:
    encoded = urllib.parse.quote(arxiv_id, safe="")
    url = f"http://export.arxiv.org/api/query?id_list={encoded}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            xml_bytes = resp.read()
    except Exception:
        return None

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return None

    ns = {"atom": "http://www.w3.org/2005/Atom"}
    entry = root.find("atom:entry", ns)
    if entry is None:
        return None

    title_el = entry.find("atom:title", ns)
    title = re.sub(r"\s+", " ", title_el.text.strip()) if title_el is not None and title_el.text else ""
    authors: list[str] = []
    for author_el in entry.findall("atom:author", ns):
        name_el = author_el.find("atom:name", ns)
        if name_el is not None and name_el.text:
            authors.append(name_el.text.strip())

    published_el = entry.find("atom:published", ns)
    year: int | None = None
    if published_el is not None and published_el.text:
        year_match = YEAR_PATTERN.search(published_el.text)
        if year_match:
            year = int(year_match.group(1))

    return {
        "title": title,
        "authors": ", ".join(authors),
        "publication_year": year,
        "doi": f"10.48550/arXiv.{arxiv_id.split('v')[0]}",
        "venue": f"arXiv preprint arXiv:{arxiv_id}",
    }


def build_bibtex_key(authors: str, year: int | None, title: str) -> str:
    first_author = authors.split(",")[0].strip() if authors else "unknown"
    surname = first_author.split()[-1] if first_author else "unknown"
    surname_clean = re.sub(r"[^a-z0-9]", "", surname.lower()) or "paper"

    year_str = str(year) if year else "nd"

    words = re.findall(r"[a-z0-9]+", title.lower())
    first_word = "work"
    for word in words:
        if word not in STOPWORDS and len(word) > 2:
            first_word = word
            break

    return f"{surname_clean}{year_str}{first_word}"


def escape_bibtex(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", value).strip()
    return cleaned.replace("{", "").replace("}", "")


def format_bibtex_authors(authors: str) -> str:
    parts = [p.strip() for p in authors.split(",") if p.strip()]
    return " and ".join(parts) if parts else "Unknown"


def build_bibtex_entry(
    key: str,
    title: str,
    authors: str,
    year: int | None,
    doi: str,
    venue: str = "",
) -> str:
    entry_type = "article" if venue or doi else "misc"
    lines = [f"@{entry_type}{{{key},"]
    lines.append(f"  title = {{{escape_bibtex(title)}}},")
    lines.append(f"  author = {{{escape_bibtex(format_bibtex_authors(authors))}}},")
    if year is not None:
        lines.append(f"  year = {{{year}}},")
    if venue:
        lines.append(f"  journal = {{{escape_bibtex(venue)}}},")
    if doi:
        lines.append(f"  doi = {{{escape_bibtex(doi)}}},")
    lines.append("}")
    return "\n".join(lines)


def infer_from_pdf(
    info: dict[str, str],
    text: str,
    largest_title: str,
    fallback_name: str,
) -> tuple[str, str, int | None]:
    title = info.get("title", "").strip()
    if not title or title.lower().startswith("untitled") or title.lower().endswith(".pdf"):
        title = largest_title.strip()
    if not title:
        for line in text.splitlines():
            candidate = line.strip()
            if len(candidate) > 8 and not candidate.lower().startswith("arxiv"):
                title = candidate
                break
    if not title:
        title = fallback_name

    authors = info.get("author", "").strip()
    year: int | None = None
    creation = info.get("creationDate", "") or info.get("modDate", "")
    year_match = YEAR_PATTERN.search(creation) or YEAR_PATTERN.search(text[:2000])
    if year_match:
        year = int(year_match.group(1))

    return title, authors, year


def extract_metadata(
    pdf_path: Path,
    fallback_filename: str = "",
    skip_network: bool = False,
) -> PaperMetadata:
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF file does not exist: {pdf_path}")

    fallback_stem = Path(fallback_filename or pdf_path.name).stem
    info, text, largest_title = extract_pdf_text_and_info(pdf_path)
    doi, arxiv_id = find_identifiers(info, text)

    remote_data: dict[str, Any] | None = None
    if not skip_network:
        if doi:
            remote_data = fetch_crossref(doi)
        if remote_data is None and arxiv_id:
            remote_data = fetch_arxiv(arxiv_id)

    inferred_title, inferred_authors, inferred_year = infer_from_pdf(
        info, text, largest_title, fallback_stem
    )

    title = (remote_data or {}).get("title") or inferred_title or fallback_stem
    authors = (remote_data or {}).get("authors") or inferred_authors or "Unknown"
    year = (remote_data or {}).get("publication_year") or inferred_year
    final_doi = (remote_data or {}).get("doi") or doi
    venue = (remote_data or {}).get("venue") or ""

    bibtex_key = build_bibtex_key(authors, year, title)
    bibtex_raw = build_bibtex_entry(bibtex_key, title, authors, year, final_doi, venue)

    return PaperMetadata(
        title=title,
        authors=authors,
        publication_year=year,
        doi=final_doi,
        bibtex_key=bibtex_key,
        bibtex_raw=bibtex_raw,
    )


def extract_full_markdown_text(pdf_path: Path) -> str:
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) is required to read PDF files.")
    doc = fitz.open(pdf_path)
    try:
        sections: list[str] = []
        for idx, page in enumerate(doc):
            page_text = page.get_text("text").strip()
            if page_text:
                sections.append(f"## Page {idx + 1}\n\n{page_text}")
        return "\n\n".join(sections)
    finally:
        doc.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract metadata and BibTeX from a PDF file.")
    parser.add_argument("pdf_path", type=Path, help="Path to the PDF file")
    parser.add_argument("--filename", default="", help="Original uploaded filename")
    parser.add_argument("--offline", action="store_true", help="Skip external API lookups")
    parser.add_argument("--extract-text", action="store_true", help="Print extracted Markdown full text")
    args = parser.parse_args(argv)

    try:
        if args.extract_text:
            print(extract_full_markdown_text(args.pdf_path))
            return 0
        meta = extract_metadata(
            pdf_path=args.pdf_path,
            fallback_filename=args.filename,
            skip_network=args.offline,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1

    print(json.dumps(asdict(meta), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

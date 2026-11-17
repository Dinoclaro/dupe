#!/usr/bin/env python3
"""Imports a Zotero exported directory (PDFs and optional RDF) into dupe and tests syncing."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
import re
import sys
import time
from typing import Any
import xml.etree.ElementTree as ET

import requests

from scripts.extract_meta import (
    DOI_PATTERN,
    YEAR_PATTERN,
    build_bibtex_entry,
    build_bibtex_key,
    clean_doi,
)

RDF_NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "z": "http://www.zotero.org/namespaces/export#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "bib": "http://purl.org/net/biblio#",
    "dcterms": "http://purl.org/dc/terms/",
    "link": "http://purl.org/rss/1.0/modules/link/",
}


@dataclass(frozen=True)
class RdfEntry:
    title: str
    authors: str
    year: int | None
    doi: str
    tags: list[str]


def parse_zotero_rdf(rdf_path: Path) -> dict[str, RdfEntry]:
    if not rdf_path.is_file():
        return {}

    try:
        tree = ET.parse(rdf_path)
    except ET.ParseError:
        return {}

    root = tree.getroot()
    about_attr = f"{{{RDF_NS['rdf']}}}about"
    resource_attr = f"{{{RDF_NS['rdf']}}}resource"

    attachment_paths: dict[str, str] = {}
    for att in root.findall("z:Attachment", RDF_NS):
        att_id = att.attrib.get(about_attr, "")
        path_el = att.find("z:path", RDF_NS)
        if att_id and path_el is not None:
            rel_path = path_el.attrib.get(resource_attr, "")
            if rel_path.lower().endswith(".pdf"):
                attachment_paths[att_id] = rel_path

    by_rel_path: dict[str, RdfEntry] = {}
    for elem in root:
        links = [
            lnk.attrib.get(resource_attr, "")
            for lnk in elem.findall("link:link", RDF_NS)
        ]
        matched_paths = [attachment_paths[lid] for lid in links if lid in attachment_paths]
        if not matched_paths:
            continue

        title_el = elem.find("dc:title", RDF_NS)
        title = re.sub(r"\s+", " ", title_el.text.strip()) if title_el is not None and title_el.text else ""

        authors_list: list[str] = []
        for person in elem.findall(".//bib:authors//foaf:Person", RDF_NS):
            given_el = person.find("foaf:givenName", RDF_NS)
            surname_el = person.find("foaf:surname", RDF_NS)
            given = given_el.text.strip() if given_el is not None and given_el.text else ""
            surname = surname_el.text.strip() if surname_el is not None and surname_el.text else ""
            full = f"{given} {surname}".strip()
            if full:
                authors_list.append(full)

        year: int | None = None
        date_el = elem.find("dc:date", RDF_NS)
        if date_el is not None and date_el.text:
            ym = YEAR_PATTERN.search(date_el.text)
            if ym:
                year = int(ym.group(1))

        doi = ""
        for ident_el in elem.findall(".//dc:identifier", RDF_NS):
            raw_text = "".join(ident_el.itertext())
            dm = DOI_PATTERN.search(raw_text)
            if dm:
                doi = clean_doi(dm.group(1))
                break

        tags: list[str] = []
        for subj in elem.findall("dc:subject", RDF_NS):
            tag_text = "".join(subj.itertext()).strip()
            if tag_text and len(tag_text) <= 40:
                tags.append(tag_text)

        entry = RdfEntry(
            title=title,
            authors=", ".join(authors_list),
            year=year,
            doi=doi,
            tags=tags[:5],
        )
        for rel in matched_paths:
            by_rel_path[rel] = entry

    return by_rel_path


def upload_one_pdf(
    session_url: str,
    token: str,
    library_dir: Path,
    pdf_path: Path,
    rdf_map: dict[str, RdfEntry],
) -> tuple[bool, str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    rel_posix = pdf_path.relative_to(library_dir).as_posix()
    rdf_info = rdf_map.get(rel_posix)

    try:
        with pdf_path.open("rb") as f:
            resp = requests.post(
                f"{session_url}/api/papers/upload",
                headers=headers,
                data={"skip_network": "true"},
                files={"file": (pdf_path.name, f, "application/pdf")},
                timeout=45,
            )
        if resp.status_code not in (200, 201):
            return False, pdf_path.name, f"HTTP {resp.status_code}: {resp.text[:120]}"

        paper: dict[str, Any] = resp.json()
        paper_id = str(paper.get("id", ""))

        if rdf_info and paper_id:
            needs_patch = False
            title = str(paper.get("title") or "")
            authors = str(paper.get("authors") or "")
            year = paper.get("publication_year")
            doi = str(paper.get("doi") or "")

            if rdf_info.title and (not title or title == pdf_path.stem):
                title = rdf_info.title
                needs_patch = True
            if rdf_info.authors and (not authors or authors == "Unknown" or "et al" in authors.lower()):
                authors = rdf_info.authors
                needs_patch = True
            if rdf_info.year and not year:
                year = rdf_info.year
                needs_patch = True
            if rdf_info.doi and not doi:
                doi = rdf_info.doi
                needs_patch = True

            if needs_patch or rdf_info.tags:
                bib_key = build_bibtex_key(authors, year, title)
                bib_raw = build_bibtex_entry(bib_key, title, authors, year, doi)
                patch_payload: dict[str, Any] = {
                    "title": title,
                    "authors": authors,
                    "publication_year": year,
                    "doi": doi,
                    "bibtex_key": bib_key,
                    "bibtex_raw": bib_raw,
                }
                if rdf_info.tags:
                    patch_payload["tags"] = rdf_info.tags
                p_resp = requests.patch(
                    f"{session_url}/api/papers/{paper_id}",
                    headers=headers,
                    json=patch_payload,
                    timeout=45,
                )
                if p_resp.status_code == 200:
                    paper = p_resp.json()

        return True, str(paper.get("bibtex_key", "")), str(paper.get("title", pdf_path.name))
    except Exception as exc:
        return False, pdf_path.name, str(exc)


def main() -> int:
    parser = argparse.ArgumentParser(description="Import Zotero export folder into dupe.")
    parser.add_argument("zotero_dir", type=Path, help="Path to Zotero export directory")
    parser.add_argument("--url", default="https://dupe.ing", help="dupe server base URL")
    parser.add_argument("--username", default="dino", help="Username")
    parser.add_argument("--password", default="dino-dev-password", help="Password")
    parser.add_argument("--workers", type=int, default=6, help="Concurrent upload workers")
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    zotero_dir: Path = args.zotero_dir

    rdf_files = list(zotero_dir.glob("*.rdf"))
    rdf_map = parse_zotero_rdf(rdf_files[0]) if rdf_files else {}
    pdf_files = sorted(zotero_dir.rglob("*.pdf"))

    print(f"Found {len(pdf_files)} PDFs and {len(rdf_map)} RDF metadata mappings in '{zotero_dir}'.")

    login_resp = requests.post(
        f"{base_url}/api/auth/login",
        json={"username": args.username, "password": args.password},
        timeout=15,
    )
    login_resp.raise_for_status()
    token = login_resp.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    started = time.time()
    succeeded = 0
    failed: list[tuple[str, str]] = []
    sample_keys: list[str] = []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(upload_one_pdf, base_url, token, zotero_dir, pdf, rdf_map)
            for pdf in pdf_files
        ]
        for idx, fut in enumerate(as_completed(futures), start=1):
            ok, key_or_name, detail = fut.result()
            if ok:
                succeeded += 1
                if len(sample_keys) < 12 and key_or_name:
                    sample_keys.append(f"@{key_or_name} ({detail[:55]})")
            else:
                failed.append((key_or_name, detail))
            if idx % 25 == 0 or idx == len(pdf_files):
                elapsed = time.time() - started
                print(f"  Progress: {idx}/{len(pdf_files)} processed ({succeeded} ok, {len(failed)} failed) in {elapsed:.1f}s")

    # Verify Library Sync API (/api/library/changes)
    changes_resp = requests.get(
        f"{base_url}/api/library/changes?since=2020-01-01T00:00:00Z",
        headers=headers,
        timeout=20,
    )
    changes_resp.raise_for_status()
    synced_papers = changes_resp.json().get("papers", [])

    # Trigger Project Sync so AGENTS.md, paper/references.bib, and refs/index.json update
    projects_resp = requests.get(f"{base_url}/api/projects", headers=headers, timeout=15)
    projects_resp.raise_for_status()
    projects = projects_resp.json()
    synced_proj_name = ""
    if projects:
        proj_id = projects[0]["id"]
        synced_proj_name = projects[0]["name"]
        sync_resp = requests.post(
            f"{base_url}/api/projects/{proj_id}/sync",
            headers=headers,
            json={"commit_message": "chore(dupe): import Zotero library"},
            timeout=120,
        )
        sync_resp.raise_for_status()

    print("\n=== Zotero Import & Sync Summary ===")
    print(f"Target server:      {base_url}")
    print(f"Uploaded PDFs:      {succeeded}/{len(pdf_files)}")
    print(f"Synced in library:  {len(synced_papers)} unique papers (after SHA-256 deduplication)")
    if synced_proj_name:
        print(f"Synced project:     {synced_proj_name} (regenerated AGENTS.md, paper/references.bib, refs/index.json)")
    if sample_keys:
        print("Sample citations:")
        for sk in sample_keys[:8]:
            print(f"  - {sk}")
    if failed:
        print(f"Failed files ({len(failed)}):")
        for fname, err_msg in failed[:10]:
            print(f"  - {fname}: {err_msg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

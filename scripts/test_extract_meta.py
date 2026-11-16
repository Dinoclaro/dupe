from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import fitz  # PyMuPDF

from scripts.extract_meta import (
    build_bibtex_entry,
    build_bibtex_key,
    clean_doi,
    extract_metadata,
    find_identifiers,
    main,
)


class ExtractMetaTests(unittest.TestCase):
    def test_clean_doi_strips_trailing_punctuation(self) -> None:
        self.assertEqual(clean_doi("10.1145/12345.67890)."), "10.1145/12345.67890")

    def test_find_identifiers_detects_doi_and_arxiv(self) -> None:
        text = "Published under DOI: 10.1038/nature14539 and arXiv:1706.03762v5."
        doi, arxiv_id = find_identifiers({}, text)
        self.assertEqual(doi, "10.1038/nature14539")
        self.assertEqual(arxiv_id, "1706.03762v5")

    def test_build_bibtex_key_is_deterministic(self) -> None:
        key = build_bibtex_key(
            authors="Ashish Vaswani, Noam Shazeer",
            year=2017,
            title="Attention Is All You Need",
        )
        self.assertEqual(key, "vaswani2017attention")

    def test_build_bibtex_entry_formats_fields(self) -> None:
        raw = build_bibtex_entry(
            key="vaswani2017attention",
            title="Attention Is All You Need",
            authors="Ashish Vaswani, Noam Shazeer",
            year=2017,
            doi="10.48550/arXiv.1706.03762",
            venue="NeurIPS",
        )
        self.assertIn("@article{vaswani2017attention,", raw)
        self.assertIn("author = {Ashish Vaswani and Noam Shazeer},", raw)
        self.assertIn("year = {2017},", raw)
        self.assertIn("doi = {10.48550/arXiv.1706.03762},", raw)

    def test_extract_metadata_from_sample_pdf_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            pdf_path = Path(tmp_dir) / "sample.pdf"
            doc = fitz.open()
            page = doc.new_page()
            page.insert_text((72, 72), "Deep Residual Learning for Image Recognition", fontsize=18)
            page.insert_text((72, 110), "Kaiming He, Xiangyu Zhang (2016)", fontsize=12)
            page.insert_text((72, 140), "DOI: 10.1109/CVPR.2016.90", fontsize=10)
            doc.set_metadata({"author": "Kaiming He, Xiangyu Zhang"})
            doc.save(pdf_path)
            doc.close()

            meta = extract_metadata(pdf_path, skip_network=True)
            self.assertEqual(meta.title, "Deep Residual Learning for Image Recognition")
            self.assertEqual(meta.authors, "Kaiming He, Xiangyu Zhang")
            self.assertEqual(meta.publication_year, 2016)
            self.assertEqual(meta.doi, "10.1109/CVPR.2016.90")
            self.assertEqual(meta.bibtex_key, "he2016deep")
            self.assertIn("@article{he2016deep,", meta.bibtex_raw)

            exit_code = main([str(pdf_path), "--offline"])
            self.assertEqual(exit_code, 0)


if __name__ == "__main__":
    unittest.main()

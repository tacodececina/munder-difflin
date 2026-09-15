import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("report.py")


def load_report():
    spec = importlib.util.spec_from_file_location("lid_report", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evidence(records=None, **overrides):
    data = {
        "schemaVersion": 1,
        "collectedAt": "2026-09-15T16:00:00Z",
        "collector": "GPT-5.6-sol",
        "scope": "LID-0 inventory",
        "records": records if records is not None else [record()],
    }
    data.update(overrides)
    return data


def record(**overrides):
    data = {
        "id": "fixture-runtime",
        "title": "Runtime <sintético>",
        "category": "runtime",
        "host": "fixture-host",
        "status": "verified",
        "observedAt": "2026-09-15T15:59:00Z",
        "source": "fixture: comando --flag <script>alert(1)</script>",
        "summary": "Dato observado; no acredita producción lista.",
        "details": {"workers": None, "attribute": '" onmouseover="alert(2)'},
        "limitations": ["Fixture sintético; cobertura parcial."],
        "remeasure": "Repetir consulta autorizada al runtime.",
    }
    data.update(overrides)
    return data


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.report = load_report()

    def test_loads_valid_documents_and_preserves_null(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "one.json").write_text(json.dumps(evidence()), encoding="utf-8")
            records, files = self.report.load_evidence(Path(folder))
        self.assertEqual(records[0]["details"]["workers"], None)
        self.assertEqual(files, ["one.json"])

    def test_rejects_schema_errors_and_missing_utc_date(self):
        invalid = [
            evidence(schemaVersion=2),
            evidence(collectedAt="2026-09-15T16:00:00"),
            evidence(records=[record(observedAt=None)]),
            evidence(records=[record(status="ready")]),
            evidence(records=[record(details=[])]),
            evidence(records=[record(limitations="none")]),
            evidence(records=[record(limitations=[""])]),
            evidence(records=[record(details={"bad": object()})]),
            evidence(extra="unexpected"),
        ]
        for index, payload in enumerate(invalid):
            with self.subTest(index=index):
                with self.assertRaises(self.report.EvidenceError):
                    self.report.validate_document(payload, "bad.json")

    def test_validates_nested_json_detail_values(self):
        payload = evidence(records=[record(details={"nested": [True, 3, {"value": "ok"}]})])
        self.assertEqual(self.report.validate_document(payload, "nested.json")[0]["id"], "fixture-runtime")

    def test_accepts_named_collectors_and_preserves_document_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            payload = evidence(collector="GPT-6-Astra")
            Path(folder, "astra.json").write_text(json.dumps(payload), encoding="utf-8")
            records, _ = self.report.load_evidence(
                Path(folder), now=datetime(2026, 9, 15, 16, 1, tzinfo=timezone.utc)
            )
        self.assertEqual(records[0]["_collector"], "GPT-6-Astra")
        self.assertEqual(records[0]["_collectedAt"], "2026-09-15T16:00:00Z")
        self.assertEqual(records[0]["_file"], "astra.json")

    def test_rejects_non_integer_version_nonfinite_numbers_and_bad_status_type(self):
        invalid = [
            evidence(schemaVersion=1.0),
            evidence(records=[record(details={"load": float("nan")})]),
            evidence(records=[record(details={"load": float("inf")})]),
            evidence(records=[record(status=[])]),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(self.report.EvidenceError):
                self.report.validate_document(payload, "bad.json")

    def test_rejects_observation_after_collection_and_far_future_collection(self):
        now = datetime(2026, 9, 15, 16, 0, tzinfo=timezone.utc)
        invalid = [
            evidence(records=[record(observedAt="2026-09-15T16:00:01Z")]),
            evidence(collectedAt="2026-09-15T16:06:00Z"),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(self.report.EvidenceError):
                self.report.validate_document(payload, "bad.json", now=now)

    def test_rejects_sensitive_detail_keys_recursively(self):
        for details in ({"password": "x"}, {"nested": [{"api_key": "x"}]}, {"raw_env": {}} , {"body": "mail"}, {"prompt": "customer"}):
            with self.subTest(details=details), self.assertRaisesRegex(self.report.EvidenceError, "sensible"):
                self.report.validate_document(evidence(records=[record(details=details)]), "bad.json")

    def test_rejects_corrupt_json_and_duplicate_ids_across_files(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "bad.json").write_text("{broken", encoding="utf-8")
            with self.assertRaisesRegex(self.report.EvidenceError, "JSON inválido"):
                self.report.load_evidence(Path(folder))
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "a.json").write_text(json.dumps(evidence()), encoding="utf-8")
            Path(folder, "b.json").write_text(json.dumps(evidence()), encoding="utf-8")
            with self.assertRaisesRegex(self.report.EvidenceError, "duplicado"):
                self.report.load_evidence(Path(folder))

    def test_load_rejects_nonstandard_nan_json(self):
        with tempfile.TemporaryDirectory() as folder:
            payload = evidence(records=[record(details={"load": float("nan")})])
            Path(folder, "nan.json").write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(self.report.EvidenceError, "JSON inválido"):
                self.report.load_evidence(Path(folder))


class RenderingTests(unittest.TestCase):
    def setUp(self):
        self.report = load_report()

    def test_render_is_self_contained_escaped_and_truthful(self):
        html = self.report.render_report([record()], ["fixture.json"])
        self.assertIn("CAPTURA / NO MONITOR EN VIVO", html)
        self.assertIn("VERIFICADO: DATO OBSERVADO", html)
        self.assertIn("NO SIGNIFICA LISTO PARA PRODUCCIÓN", html)
        self.assertIn("2026-09-15T15:59:00Z", html)
        self.assertIn("Fixture sintético; cobertura parcial.", html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertNotIn('onmouseover="alert(2)', html)
        self.assertIn("Desconocido (null)", html)
        self.assertNotRegex(html, r"https?://")
        self.assertNotIn("innerHTML", html)
        self.assertNotIn("setInterval", html)

    def test_empty_evidence_is_pending_not_pass(self):
        html = self.report.render_report([], [])
        self.assertIn("SIN EVIDENCIA CARGADA", html)
        self.assertIn("PENDIENTE", html)
        self.assertNotIn(">PASS<", html)
        self.assertNotIn("0 hosts verificados", html)

    def test_all_statuses_and_astra_audit_pending_are_visible(self):
        records = [
            record(id="v", status="verified"),
            record(id="u", status="unknown", title="Desconocido"),
            record(id="b", status="blocked", title="Bloqueado"),
        ]
        html = self.report.render_report(records, ["fixture.json"])
        self.assertIn("DESCONOCIDO", html)
        self.assertIn("BLOQUEADO", html)
        self.assertIn("AUDITORÍA ASTRA 6", html)
        self.assertIn("Pendiente — no aportada", html)
        self.assertIn('type="search"', html)
        self.assertIn("<details", html)

    def test_render_shows_document_provenance(self):
        item = record()
        item.update({"_collector": "GPT-5.6-sol", "_collectedAt": "2026-09-15T16:00:00Z", "_file": "fixture.json"})
        html = self.report.render_report([item], ["fixture.json"])
        self.assertIn("GPT-5.6-sol", html)
        self.assertIn("2026-09-15T16:00:00Z", html)

    def test_astra_audit_footer_is_derived_only_from_structured_record(self):
        audit = record(
            id="astra6-lid0-code-review",
            category="audit",
            title="Revisión de código Astra 6",
            details={
                "verdict": "approved",
                "auditorModel": "gpt-6-astra",
                "reviewedFiles": [{"path": "tools/deploy/lid/report.py", "sha256": "a" * 64}],
            },
        )
        audit.update({"_collector": "GPT-6-Astra", "_collectedAt": "2026-09-15T16:00:00Z", "_file": "audit.json"})
        html = self.report.render_report([audit], ["audit.json"])
        self.assertIn("APROBADA", html)
        self.assertIn("Alcance: 1 archivo revisado", html)
        audit["details"]["verdict"] = "request_changes"
        self.assertIn("CAMBIOS SOLICITADOS", self.report.render_report([audit], ["audit.json"]))

    def test_malformed_astra_record_is_rejected(self):
        audit = record(id="astra6-lid0-code-review", category="audit", details={"verdict": "approved"})
        with self.assertRaisesRegex(self.report.EvidenceError, "auditoría"):
            self.report.validate_document(evidence(records=[audit], collector="GPT-6-Astra"), "audit.json")

    def test_reserved_astra_record_requires_category_verified_status_and_text_verdict(self):
        base_details = {
            "verdict": "approved",
            "auditorModel": "gpt-6-astra",
            "reviewedFiles": [{"path": "tools/deploy/lid/report.py", "sha256": "a" * 64}],
        }
        invalid = [
            record(id="astra6-lid0-code-review", category="runtime", details=base_details),
            record(id="astra6-lid0-code-review", category="audit", status="unknown", details=base_details),
            record(id="astra6-lid0-code-review", category="audit", details={**base_details, "verdict": []}),
        ]
        for audit in invalid:
            with self.subTest(audit=audit), self.assertRaises(self.report.EvidenceError):
                self.report.validate_document(evidence(records=[audit], collector="GPT-6-Astra"), "audit.json")

    def test_cli_rejects_corruption_without_creating_report(self):
        with tempfile.TemporaryDirectory() as folder:
            evidence_dir = Path(folder, "evidence")
            evidence_dir.mkdir()
            Path(evidence_dir, "bad.json").write_text("[]", encoding="utf-8")
            output = Path(folder, "report.html")
            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), "--evidence", str(evidence_dir), "--output", str(output)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("ERROR DE EVIDENCIA", result.stderr)
            self.assertFalse(output.exists())

    def test_main_writes_empty_pending_report_and_reports_output_error(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder, "report.html")
            with redirect_stdout(StringIO()):
                result = self.report.main(["--evidence", str(Path(folder, "missing")), "--output", str(output)])
            self.assertEqual(result, 0)
            self.assertIn("SIN EVIDENCIA CARGADA", output.read_text(encoding="utf-8"))
            with redirect_stderr(StringIO()):
                result = self.report.main(["--evidence", str(Path(folder, "missing")), "--output", folder])
            self.assertEqual(result, 3)

    def test_main_returns_evidence_error(self):
        with tempfile.TemporaryDirectory() as folder:
            evidence_dir = Path(folder, "evidence")
            evidence_dir.mkdir()
            Path(evidence_dir, "bad.json").write_text("[]", encoding="utf-8")
            with redirect_stderr(StringIO()):
                result = self.report.main(["--evidence", str(evidence_dir), "--output", str(Path(folder, "out.html"))])
            self.assertEqual(result, 2)


if __name__ == "__main__":
    unittest.main()

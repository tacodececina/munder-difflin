#!/usr/bin/env python3
"""Build a read-only, self-contained LID-0 inventory evidence report."""

from __future__ import annotations

import argparse
import html
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


class EvidenceError(ValueError):
    """Evidence cannot be represented truthfully."""


DOCUMENT_FIELDS = {"schemaVersion", "collectedAt", "collector", "scope", "records"}
RECORD_FIELDS = {
    "id", "title", "category", "host", "status", "observedAt", "source",
    "summary", "details", "limitations", "remeasure",
}
STATUSES = {"verified", "unknown", "blocked"}
COLLECTORS = {"GPT-5.6-sol", "GPT-6-Astra"}
SENSITIVE_DETAIL_KEYS = {"password", "api_key", "raw_env", "body", "prompt"}
STATUS_LABELS = {
    "verified": "VERIFICADO: DATO OBSERVADO",
    "unknown": "DESCONOCIDO",
    "blocked": "BLOQUEADO",
}


def _require_exact_fields(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    extra = sorted(value.keys() - expected)
    if missing or extra:
        parts = []
        if missing:
            parts.append("faltan " + ", ".join(missing))
        if extra:
            parts.append("sobran " + ", ".join(extra))
        raise EvidenceError(f"{context}: campos inválidos ({'; '.join(parts)})")


def _require_text(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvidenceError(f"{context}: se requiere texto no vacío")
    return value


def _require_utc(value: Any, context: str) -> datetime:
    text = _require_text(value, context)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvidenceError(f"{context}: fecha ISO inválida") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise EvidenceError(f"{context}: la fecha debe indicar UTC")
    return parsed


def _validate_json_value(value: Any, context: str) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise EvidenceError(f"{context}: número no finito")
    if value is None or isinstance(value, (str, int, float, bool)):
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_value(item, f"{context}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise EvidenceError(f"{context}: clave no textual")
            if key.casefold() in SENSITIVE_DETAIL_KEYS:
                raise EvidenceError(f"{context}.{key}: nombre de campo sensible no permitido")
            _validate_json_value(item, f"{context}.{key}")
        return
    raise EvidenceError(f"{context}: valor no representable")


def _validate_audit_record(record: dict[str, Any], collector: str, context: str) -> None:
    if record["id"] != "astra6-lid0-code-review":
        return
    if record["category"] != "audit":
        raise EvidenceError(f"{context}: el id reservado de auditoría requiere category audit")
    if record["status"] != "verified":
        raise EvidenceError(f"{context}: el dictamen de auditoría requiere status verified")
    details = record["details"]
    if collector != "GPT-6-Astra" or details.get("auditorModel") != "gpt-6-astra":
        raise EvidenceError(f"{context}: atribución de auditoría Astra inválida")
    verdict = details.get("verdict")
    if not isinstance(verdict, str) or verdict not in {"approved", "request_changes"}:
        raise EvidenceError(f"{context}: veredicto de auditoría inválido")
    reviewed = details.get("reviewedFiles")
    if not isinstance(reviewed, list) or not reviewed:
        raise EvidenceError(f"{context}: auditoría sin archivos revisados")
    for index, item in enumerate(reviewed):
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            raise EvidenceError(f"{context}: archivo de auditoría [{index}] inválido")
        _require_text(item["path"], f"{context}.reviewedFiles[{index}].path")
        digest = item["sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise EvidenceError(f"{context}: sha256 de auditoría inválido")


def validate_document(
    document: Any, filename: str, *, now: datetime | None = None
) -> list[dict[str, Any]]:
    if not isinstance(document, dict):
        raise EvidenceError(f"{filename}: la raíz debe ser un objeto")
    _require_exact_fields(document, DOCUMENT_FIELDS, filename)
    if type(document["schemaVersion"]) is not int or document["schemaVersion"] != 1:
        raise EvidenceError(f"{filename}: schemaVersion debe ser 1")
    collected_at = _require_utc(document["collectedAt"], f"{filename}.collectedAt")
    current = now or datetime.now(timezone.utc)
    if collected_at > current + timedelta(minutes=5):
        raise EvidenceError(f"{filename}.collectedAt: fecha futura fuera de tolerancia")
    if not isinstance(document["collector"], str) or document["collector"] not in COLLECTORS:
        raise EvidenceError(f"{filename}: collector no autorizado para esta entrega")
    if document["scope"] != "LID-0 inventory":
        raise EvidenceError(f"{filename}: scope inesperado")
    if not isinstance(document["records"], list):
        raise EvidenceError(f"{filename}.records: debe ser arreglo")

    validated = []
    for index, record in enumerate(document["records"]):
        context = f"{filename}.records[{index}]"
        if not isinstance(record, dict):
            raise EvidenceError(f"{context}: debe ser objeto")
        _require_exact_fields(record, RECORD_FIELDS, context)
        for field in ("id", "title", "category", "host", "source", "summary", "remeasure"):
            _require_text(record[field], f"{context}.{field}")
        if not isinstance(record["status"], str) or record["status"] not in STATUSES:
            raise EvidenceError(f"{context}.status: valor inválido")
        observed_at = _require_utc(record["observedAt"], f"{context}.observedAt")
        if observed_at > collected_at:
            raise EvidenceError(f"{context}.observedAt: posterior a collectedAt")
        if not isinstance(record["details"], dict):
            raise EvidenceError(f"{context}.details: debe ser objeto")
        _validate_json_value(record["details"], f"{context}.details")
        if not isinstance(record["limitations"], list):
            raise EvidenceError(f"{context}.limitations: debe ser arreglo")
        for limitation_index, limitation in enumerate(record["limitations"]):
            _require_text(limitation, f"{context}.limitations[{limitation_index}]")
        _validate_audit_record(record, document["collector"], context)
        validated.append(record)
    return validated


def load_evidence(
    directory: Path, *, now: datetime | None = None
) -> tuple[list[dict[str, Any]], list[str]]:
    if not directory.exists() or not directory.is_dir():
        return [], []
    files = sorted(directory.glob("*.json"), key=lambda path: path.name.casefold())
    records: list[dict[str, Any]] = []
    seen: dict[str, str] = {}
    for path in files:
        try:
            document = json.loads(
                path.read_text(encoding="utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
        except (OSError, UnicodeError, ValueError) as exc:
            raise EvidenceError(f"{path.name}: JSON inválido ({exc})") from exc
        for record in validate_document(document, path.name, now=now):
            record_id = record["id"]
            if record_id in seen:
                raise EvidenceError(
                    f"id duplicado {record_id!r} en {seen[record_id]} y {path.name}"
                )
            seen[record_id] = path.name
            enriched = dict(record)
            enriched.update({
                "_collector": document["collector"],
                "_collectedAt": document["collectedAt"],
                "_file": path.name,
            })
            records.append(enriched)
    return records, [path.name for path in files]


def _escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _detail_value(value: Any) -> str:
    if value is None:
        return "Desconocido (null)"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def _record_card(record: dict[str, Any]) -> str:
    searchable = " ".join(
        str(record[field]) for field in ("id", "title", "category", "host", "status", "summary")
    ).casefold()
    details = "".join(
        f"<dt>{_escape(key)}</dt><dd><code>{_escape(_detail_value(value))}</code></dd>"
        for key, value in sorted(record["details"].items())
    ) or "<dt>Detalle</dt><dd>Sin campos reportados</dd>"
    limitations = "".join(f"<li>{_escape(item)}</li>" for item in record["limitations"])
    if not limitations:
        limitations = "<li>No declaradas por el recolector; revisar antes de usar la evidencia.</li>"
    return f"""
      <article class="record status-{record['status']}" data-search="{_escape(searchable)}" data-status="{record['status']}">
        <div class="record-main">
          <div><span class="category">{_escape(record['category'])}</span><h2>{_escape(record['title'])}</h2><code>{_escape(record['id'])}</code></div>
          <div><span class="badge">{STATUS_LABELS[record['status']]}</span><strong>{_escape(record['host'])}</strong></div>
        </div>
        <p class="summary">{_escape(record['summary'])}</p>
        <dl class="facts"><dt>Observado</dt><dd><time datetime="{_escape(record['observedAt'])}">{_escape(record['observedAt'])}</time></dd><dt>Fuente</dt><dd><code>{_escape(record['source'])}</code></dd><dt>Recolector</dt><dd>{_escape(record.get('_collector', 'No indicado en llamada directa'))}</dd><dt>Documento</dt><dd><code>{_escape(record.get('_file', 'No indicado'))}</code> · <time>{_escape(record.get('_collectedAt', 'No indicado'))}</time></dd></dl>
        <details><summary>Ver detalle, límites y remedición</summary><div class="detail-grid"><section><h3>Detalle observado</h3><dl>{details}</dl></section><section><h3>Limitaciones</h3><ul>{limitations}</ul><h3>Cómo volver a medir</h3><p>{_escape(record['remeasure'])}</p></section></div></details>
      </article>"""


def render_report(records: list[dict[str, Any]], files: list[str]) -> str:
    cards = "".join(_record_card(record) for record in records)
    if records:
        headline = f"{len(records)} registros de evidencia cargados"
        file_note = f"Archivos validados: {', '.join(files)}"
    else:
        headline = "SIN EVIDENCIA CARGADA"
        file_note = "PENDIENTE: agregue documentos JSON válidos y regenere esta captura."
        cards = '<section class="empty" role="status"><strong>PENDIENTE</strong><p>No hay registros válidos para mostrar. La ausencia de evidencia no demuestra cero recursos, buen estado ni finalización.</p></section>'
    audit = next((record for record in records if record["id"] == "astra6-lid0-code-review" and record["category"] == "audit"), None)
    if audit:
        verdict = audit["details"]["verdict"]
        audit_label = "APROBADA" if verdict == "approved" else "CAMBIOS SOLICITADOS"
        reviewed_count = len(audit["details"]["reviewedFiles"])
        audit_note = f"{audit_label}. Alcance: {reviewed_count} archivo{'s' if reviewed_count != 1 else ''} revisado{'s' if reviewed_count != 1 else ''}; consulte el registro para hashes, límites y fecha."
    else:
        audit_note = "Pendiente — no aportada. Esta captura no la sustituye ni acredita revisión de código."
    return f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LID-0 / revisión de evidencia</title>
<style>
:root{{color-scheme:dark;--bg:#091014;--panel:#10191e;--edge:#34464e;--ink:#e7eeef;--muted:#9aabb2;--ok:#7fe0bd;--warn:#f0bf72;--bad:#ef8e82}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 'Cascadia Code',Consolas,monospace}}main{{max-width:1420px;margin:auto;padding:28px 38px 48px}}h1{{font-size:25px;margin:.3rem 0}}h2{{font-size:17px;margin:.2rem 0}}h3{{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}}p{{margin:.5rem 0}}code{{white-space:pre-wrap;overflow-wrap:anywhere;color:#c8d5d9}}.capture{{border:2px solid var(--warn);background:#2a2318;color:var(--warn);padding:12px 16px;font-weight:700;letter-spacing:.08em}}.intro{{display:flex;justify-content:space-between;gap:24px;margin:24px 0;align-items:end}}.muted,.category{{color:var(--muted)}}.guardrail{{border-left:3px solid var(--warn);padding:10px 14px;background:#171a18;margin-bottom:20px}}.toolbar{{display:flex;gap:12px;flex-wrap:wrap;align-items:end;border:1px solid var(--edge);padding:15px;background:var(--panel)}}label{{display:grid;gap:5px;color:var(--muted)}}input,select{{font:inherit;color:var(--ink);background:#081014;border:1px solid var(--edge);min-height:44px;padding:7px 10px}}input{{min-width:min(420px,80vw)}}:focus-visible{{outline:2px solid var(--ok);outline-offset:3px}}.records{{display:grid;gap:14px;margin-top:16px}}.record{{border:1px solid var(--edge);background:var(--panel)}}.record-main{{display:grid;grid-template-columns:1fr auto;gap:16px;padding:15px 18px;border-bottom:1px solid var(--edge)}}.record-main>div:last-child{{text-align:right;display:grid;gap:7px}}.badge{{font-size:11px;font-weight:700;color:var(--warn)}}.status-verified .badge{{color:var(--ok)}}.status-blocked .badge{{color:var(--bad)}}.summary,.facts,details{{padding:0 18px}}.facts,details dl{{display:grid;grid-template-columns:125px minmax(0,1fr);gap:8px}}dt{{color:var(--muted)}}dd{{margin:0;overflow-wrap:anywhere}}details{{border-top:1px solid var(--edge);padding-block:12px}}summary{{cursor:pointer;min-height:44px;padding-top:10px;color:var(--ok)}}.detail-grid{{display:grid;grid-template-columns:1fr 1fr;gap:28px}}.empty{{border:1px solid var(--warn);padding:22px;color:var(--warn)}}.audit{{margin-top:22px;border:1px solid var(--warn);padding:15px}}[hidden]{{display:none!important}}@media(max-width:720px){{main{{padding:16px}}.intro,.record-main,.detail-grid{{display:block}}.record-main>div:last-child{{text-align:left;margin-top:12px}}.facts,details dl{{grid-template-columns:1fr}}input{{min-width:0;width:100%}}}}
</style></head><body><main>
<div class="capture">CAPTURA / NO MONITOR EN VIVO</div>
<header class="intro"><div><span class="category">LID-0 · INVENTARIO</span><h1>Revisión de evidencia observada</h1><p class="muted">{_escape(headline)} · {_escape(file_note)}</p></div><p>Solo lectura · sin red · sin actualización automática</p></header>
<aside class="guardrail"><strong>VERIFICADO significa SOLO dato observado. NO SIGNIFICA LISTO PARA PRODUCCIÓN.</strong> Cada registro conserva su propia fecha, fuente, límites y método de remedición.</aside>
<section class="toolbar" aria-label="Filtros de evidencia"><label>Buscar<input id="search" type="search" placeholder="host, id, categoría o texto"></label><label>Estado<select id="status"><option value="">Todos</option><option value="verified">Verificado</option><option value="unknown">Desconocido</option><option value="blocked">Bloqueado</option></select></label><span id="count" role="status" aria-live="polite"></span></section>
<section class="records" id="records">{cards}</section>
<aside class="audit"><strong>AUDITORÍA ASTRA 6</strong><p>{_escape(audit_note)}</p></aside>
</main><script>
'use strict';
const search=document.getElementById('search');const status=document.getElementById('status');const rows=Array.from(document.querySelectorAll('.record'));const count=document.getElementById('count');
function filter(){{const term=search.value.trim().toLocaleLowerCase('es');let shown=0;for(const row of rows){{const visible=(!term||row.dataset.search.includes(term))&&(!status.value||row.dataset.status===status.value);row.hidden=!visible;if(visible)shown+=1}}count.textContent=rows.length?shown+' de '+rows.length+' registros visibles':'Sin registros';}}
search.addEventListener('input',filter);status.addEventListener('change',filter);filter();
</script></body></html>"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Genera la captura HTML de evidencia LID-0")
    parser.add_argument("--evidence", required=True, type=Path, help="directorio de JSON de evidencia")
    parser.add_argument("--output", required=True, type=Path, help="archivo HTML de salida")
    args = parser.parse_args(argv)
    try:
        records, files = load_evidence(args.evidence)
    except EvidenceError as exc:
        print(f"ERROR DE EVIDENCIA: {exc}", file=sys.stderr)
        return 2
    output = render_report(records, files)
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8", newline="\n")
    except OSError as exc:
        print(f"ERROR DE SALIDA: {exc}", file=sys.stderr)
        return 3
    print(f"Captura escrita: {args.output} ({len(records)} registros)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

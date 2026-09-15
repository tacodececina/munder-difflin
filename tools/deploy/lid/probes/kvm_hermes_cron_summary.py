#!/usr/bin/env python3
"""Print a content-free schema summary of Hermes cron persistence."""
import json
import os
import sqlite3

from kvm_probe_sanitize import safe_identifier, safe_schedule

jobs_path = "/root/.hermes/cron/jobs.json"
with open(jobs_path, encoding="utf-8") as handle:
    root = json.load(handle)
print("jobs_root_type=" + type(root).__name__)
print("jobs_root_keys=" + ",".join(sorted(root)) if isinstance(root, dict) else "jobs_root_keys=null")
if isinstance(root, dict):
    possible = root.get("jobs", root)
else:
    possible = root
items = list(possible.values()) if isinstance(possible, dict) else list(possible)
print("jobs_count=" + str(len(items)))
print("job_keys=" + (",".join(sorted(items[0])) if items and isinstance(items[0], dict) else "null"))
for job in items:
    if not isinstance(job, dict):
        continue
    script = job.get("script") or job.get("monitor_script")
    schedule = job.get("schedule_display") or job.get("schedule")
    schedule = safe_schedule(schedule)
    repeat = job.get("repeat") if isinstance(job.get("repeat"), dict) else {}
    job_id = safe_identifier(job.get("id"))
    name = safe_identifier(job.get("name"))
    origin = job.get("origin")
    function = os.path.basename(script) if isinstance(script, str) and script else None
    function = safe_identifier(function)
    safe = {
        "id": job_id,
        "name": name,
        "originPresent": origin is not None,
        "originType": type(origin).__name__ if origin is not None else None,
        "enabled": job.get("enabled") if isinstance(job.get("enabled"), bool) else None,
        "repeatCompleted": repeat.get("completed") if type(repeat.get("completed")) is int else None,
        "repeatTimes": repeat.get("times") if type(repeat.get("times")) is int else None,
        "schedule": schedule,
        "createdAt": job.get("created_at") if isinstance(job.get("created_at"), str) and all(c in "0123456789T:+.Z-" for c in job.get("created_at")) else None,
        "lastRunAt": job.get("last_run_at") if isinstance(job.get("last_run_at"), str) and all(c in "0123456789T:+.Z-" for c in job.get("last_run_at")) else None,
        "nextRunAt": job.get("next_run_at") if isinstance(job.get("next_run_at"), str) and all(c in "0123456789T:+.Z-" for c in job.get("next_run_at")) else None,
        "lastStatus": job.get("last_status") if isinstance(job.get("last_status"), str) and job.get("last_status") in {"ok", "failed", "running", "pending"} else None,
        "failureStreak": job.get("failure_streak") if type(job.get("failure_streak")) is int else None,
        "hasLastError": bool(job.get("last_error")),
        "hasLastDeliveryError": bool(job.get("last_delivery_error")),
        "function": function,
    }
    print("job=" + json.dumps(safe, sort_keys=True, separators=(",", ":")))

db_path = "/root/.hermes/cron/executions.db"
conn = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
tables = [row[0] for row in conn.execute("select name from sqlite_master where type='table' order by name")]
print("execution_tables=" + ",".join(tables))
for table in tables:
    safe_table = '"' + table.replace('"', '""') + '"'
    cols = [row[1] for row in conn.execute("pragma table_info(" + safe_table + ")")]
    print("table=" + table + "|columns=" + ",".join(cols))
if "executions" in tables:
    for row in conn.execute("select status,count(*),min(started_at),max(coalesce(finished_at,started_at)) from executions group by status order by status"):
        status = row[0] if row[0] in {"completed", "failed", "running", "pending"} else "other"
        print("execution_status=%s|count=%s|first=%s|last=%s" % (status, row[1], row[2], row[3]))
    row = conn.execute("select id,job_id,source,status,claimed_at,started_at,finished_at,error is not null from executions order by coalesce(finished_at,started_at,claimed_at) desc limit 1").fetchone()
    if row:
        latest = dict(zip(("id","jobId","source","status","claimedAt","startedAt","finishedAt","hasError"), row))
        latest["id"] = safe_identifier(latest["id"])
        latest["jobId"] = safe_identifier(latest["jobId"])
        latest["source"] = latest["source"] if latest["source"] in {"builtin", "manual", "catchup"} else None
        latest["status"] = latest["status"] if latest["status"] in {"completed", "failed", "running", "pending"} else None
        print("latest_execution=" + json.dumps(latest, sort_keys=True, separators=(",", ":")))
    else:
        print("latest_execution=null")

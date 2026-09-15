#!/usr/bin/env python3
"""Synthetic regression checks against the sanitizer used by probes."""
import subprocess
import sys

from kvm_probe_sanitize import cron_metadata, safe_schedule


secret = "TOKEN_SHOULD_NEVER_APPEAR"
assert safe_schedule("@reboot") == "@reboot"
assert safe_schedule("every 2m") == "every 2m"
assert safe_schedule("@reboot " + secret) is None
assert safe_schedule(secret) is None
assert safe_schedule(None) is None
assert safe_schedule("* * * *") is None
assert cron_metadata("", "root") is None
assert cron_metadata("# ignored", "root") is None
assert cron_metadata("TOKEN=value", "root") is None
assert cron_metadata("@invalid /opt/job.sh", "root") is None
assert cron_metadata("@reboot bad$user /opt/job.sh", "system", "fixture") is None
assert cron_metadata("unterminated 'quote", "root") is None
root = cron_metadata("@reboot /opt/job.sh --token " + secret, "root")
system = cron_metadata("@reboot appuser curl https://" + secret + ":pass@mail.example.invalid/api/cron/email-lifecycle?token=" + secret, "system", "/etc/cron.d/example")
assert root == "@reboot|/opt/job.sh|job.sh"
assert system == "/etc/cron.d/example|@reboot|user=appuser|api-route|cron/email-lifecycle|targetHost=mail.example.invalid"
assert secret not in root + system
assert cron_metadata("0 1 * * * /bin/echo harmless", "root") == "0 1 * * *||unknown"
fixture = "@reboot /opt/job.sh --token " + secret + "\n* * * * * curl https://example.invalid/api/cron/tick?token=" + secret + "\n"
completed = subprocess.run([sys.executable, __file__.replace("test_kvm_probe_sanitization.py", "kvm_probe_sanitize.py"), "--mode", "root"], input=fixture, text=True, capture_output=True, check=True)
assert secret not in completed.stdout
assert completed.stdout.splitlines() == ["@reboot|/opt/job.sh|job.sh", "* * * * *|api-route|cron/tick|targetHost=example.invalid"]
print("sanitization tests ok")

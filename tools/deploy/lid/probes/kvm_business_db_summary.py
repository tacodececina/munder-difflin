#!/usr/bin/env python3
"""Inspect only schema and aggregate counters in the LID business SQLite DB."""
import sqlite3

path = "/www/wwwroot/licenciadigital-next/db/dev.db"
conn = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
tables = [
    row[0]
    for row in conn.execute(
        "select name from sqlite_master where type='table' "
        "and (name like '%Cron%' or name like '%Email%' or name like '%Support%' or name like '%Order%') order by name"
    )
]
print("tables=" + ",".join(tables))
for table in tables:
    quoted = '"' + table.replace('"', '""') + '"'
    columns = [row[1] for row in conn.execute("pragma table_info(" + quoted + ")")]
    print("table=" + table + "|columns=" + ",".join(columns))
    print("table=" + table + "|count=" + str(conn.execute("select count(*) from " + quoted).fetchone()[0]))
    date_columns = [name for name in columns if name.lower() in {"createdat", "updatedat", "lastrunat", "lastsuccessat", "sentat", "receivedat"}]
    for column in date_columns:
        safe_column = '"' + column.replace('"', '""') + '"'
        minimum, maximum = conn.execute("select min(" + safe_column + "),max(" + safe_column + ") from " + quoted).fetchone()
        print("table=" + table + "|dateColumn=" + column + "|min=" + str(minimum) + "|max=" + str(maximum))

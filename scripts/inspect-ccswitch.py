"""列出 CC Switch 的 providers 表内容（只读，不打印密钥明文）。

用途：判断本机是否已配置可用的第三方模型供应商，从而决定成员后端能否接真实模型。
"""
import sqlite3
from pathlib import Path

db_path = Path.home() / ".cc-switch" / "cc-switch.db"
con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()


def show(table: str, limit: int = 20) -> None:
    cur.execute(f'PRAGMA table_info("{table}")')
    cols = [r[1] for r in cur.fetchall()]
    print(f"\n=== {table} ===")
    print(f"列: {', '.join(cols)}")
    cur.execute(f'SELECT * FROM "{table}" LIMIT {limit}')
    rows = cur.fetchall()
    if not rows:
        print("  (空)")
        return
    for row in rows:
        print("  ---")
        for col in cols:
            value = row[col]
            # 密钥类字段只报"有/无"，绝不打印内容
            if col.lower() in ("apikey", "api_key", "key", "token", "authtoken", "settings_config", "data"):
                if isinstance(value, str) and len(value) > 0:
                    print(f"    {col}: <{len(value)} 字符，已省略>")
                else:
                    print(f"    {col}: {value}")
            else:
                text = str(value)
                print(f"    {col}: {text[:160]}")


for t in ("providers", "provider_endpoints"):
    show(t)

con.close()

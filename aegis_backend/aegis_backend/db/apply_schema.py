"""Run schema.sql against Supabase and list resulting tables."""
import asyncio
import asyncpg
import pathlib

SQL = (pathlib.Path(__file__).parent / "schema.sql").read_text()
DB = "postgresql://postgres.rmebzlizcxjfdkwaakat:GloveDrive2026@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"


async def main():
    conn = await asyncpg.connect(DB, ssl="require", statement_cache_size=0)
    try:
        await conn.execute(SQL)
        print("SUCCESS: all tables created / already exist.")
        rows = await conn.fetch(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        )
        print("Tables in public schema:")
        for r in rows:
            print(" -", r["tablename"])
    except Exception as e:
        print("ERROR:", type(e).__name__, e)
    finally:
        await conn.close()


asyncio.run(main())

/**
 * D1-compatible adapter over PostgreSQL.
 *
 * Same contract as server/db.js (SQLite): the Worker keeps calling
 * env.DB.prepare(sql).bind(...).run()/.first()/.all() and never learns which
 * database is underneath. SQL differences are handled by worker/pgcompat.js.
 */
import pg from 'pg';
import { translate } from '../worker/pgcompat.js';

// SQLite is untyped, so the schema declares millisecond timestamps as INTEGER.
// In Postgres that is int4, which overflows at 2.1e9 — a millisecond timestamp
// is ~1.8e12 and would be rejected outright. int8 comes back as a string by
// default, so parse it or every created_at comparison silently breaks.
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));

/** DDL rewrite: widen INTEGER so ms timestamps fit, keep everything else. */
export function translateSchema(sql) {
  return sql
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bAUTOINCREMENT\b/gi, '')
    // SQLite tolerates re-declaring an index; Postgres needs IF NOT EXISTS.
    .replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE $1INDEX IF NOT EXISTS ');
}

function clean(params) {
  return params.map(p => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    return p;
  });
}

class Statement {
  constructor(pool, sql, params = []) {
    this.pool = pool;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new Statement(this.pool, this.sql, clean(values));
  }

  async #query() {
    const { sql } = translate(this.sql);
    return this.pool.query(sql, this.params);
  }

  async run() {
    const started = Date.now();
    const r = await this.#query();
    return {
      success: true,
      results: [],
      meta: {
        duration: Date.now() - started,
        changes: r.rowCount ?? 0,
        rows_written: r.rowCount ?? 0,
        last_row_id: 0,
      },
    };
  }

  /** D1 returns null, not undefined, when there is no row. */
  async first(column) {
    const r = await this.#query();
    const row = r.rows[0];
    if (row === undefined || row === null) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async all() {
    const started = Date.now();
    const r = await this.#query();
    return {
      success: true,
      results: r.rows || [],
      meta: { duration: Date.now() - started, rows_read: r.rows?.length || 0 },
    };
  }

  async raw() {
    const r = await this.#query();
    return (r.rows || []).map(row => Object.values(row));
  }
}

export class PostgresD1 {
  constructor(connectionString, { ssl = { rejectUnauthorized: false }, max = 10 } = {}) {
    this.pool = new pg.Pool({ connectionString, ssl, max, idleTimeoutMillis: 30000 });
    // A pool error must not take the process down; the next query reconnects.
    this.pool.on('error', err => console.error('[pg] idle client error:', err.message));
  }

  prepare(sql) {
    return new Statement(this.pool, sql);
  }

  async batch(statements) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = [];
      for (const s of statements) {
        const { sql } = translate(s.sql);
        const r = await client.query(sql, s.params);
        out.push({ success: true, results: r.rows || [], meta: { changes: r.rowCount ?? 0 } });
      }
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  /** Multi-statement DDL. Postgres runs these fine in one simple query. */
  async exec(sql) {
    await this.pool.query(translateSchema(sql));
    return { count: 0, duration: 0 };
  }

  async close() {
    try { await this.pool.end(); } catch (_) {}
  }
}

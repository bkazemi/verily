import type { Pool, PoolClient } from 'pg';
import type { KeyValue, Store } from './store.js';

/**
 * An instance store on Postgres, in one table of its own. Several installations can share
 * a database, each under its own namespace.
 */
export class PostgresStore implements Store {
  constructor(
    readonly pool: Pool,
    readonly namespace = 'verily',
  ) {
    if (!namespace) throw new Error('Store namespace required');
  }

  /** Creates the table. Safe to run on every start, and from several processes at once. */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // IF NOT EXISTS does not make CREATE TABLE safe to race, so one process at a time.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('verily migrate', 0))");

      await client.query(`CREATE TABLE IF NOT EXISTS verily_instance (
        namespace text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
        PRIMARY KEY (namespace, key)
      )`);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');

      throw error;
    } finally {
      client.release();
    }
  }

  get: KeyValue['get'] = (key) => this.operations(this.pool).get(key);

  put: KeyValue['put'] = (key, value) => this.operations(this.pool).put(key, value);

  delete: KeyValue['delete'] = (key) => this.operations(this.pool).delete(key);

  list: KeyValue['list'] = (prefix) => this.operations(this.pool).list(prefix);

  async transaction<T>(work: (tx: KeyValue) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // One transaction at a time for this installation, across every process serving it.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `instance ${this.namespace}`,
      ]);

      const result = await work(this.operations(client));

      await client.query('COMMIT');

      return result;
    } catch (error) {
      await client.query('ROLLBACK');

      throw error;
    } finally {
      client.release();
    }
  }

  private operations(db: Pool | PoolClient): KeyValue {
    const namespace = this.namespace;

    return {
      async get<T>(key: string) {
        const result = await db.query(
          'SELECT value FROM verily_instance WHERE namespace=$1 AND key=$2',
          [namespace, key],
        );

        return result.rows[0]?.value as T | undefined;
      },
      async put(key, value) {
        await db.query(
          `INSERT INTO verily_instance(namespace,key,value) VALUES($1,$2,$3)
          ON CONFLICT(namespace,key) DO UPDATE SET value=EXCLUDED.value`,
          [namespace, key, JSON.stringify(value)],
        );
      },
      async delete(key) {
        await db.query('DELETE FROM verily_instance WHERE namespace=$1 AND key=$2', [
          namespace,
          key,
        ]);
      },
      async list<T>(prefix: string) {
        const result = await db.query(
          `SELECT key, value FROM verily_instance
          WHERE namespace=$1 AND starts_with(key, $2) ORDER BY key COLLATE "C"`,
          [namespace, prefix],
        );

        return result.rows.map((row) => [row.key, row.value] as [string, T]);
      },
    };
  }
}

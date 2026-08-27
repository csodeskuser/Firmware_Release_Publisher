/**
 * DuckDB initialization wrapper (CommonJS)
 * 
 * Since DuckDB's npm package has better support for CommonJS,
 * this module initializes DuckDB and exports functions that can be
 * called from the ESM publisher module via dynamic import.
 */

const Database = require('duckdb').Database;
const path = require('path');

class PublicationDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
  }

  /**
   * Initialize database schema
   */
  init() {
    this.db.all(`
      CREATE TABLE IF NOT EXISTS publications (
        request_token TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        receipt TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) throw err;
    });
  }

  /**
   * Get publication by request token
   */
  getByToken(requestToken, callback) {
    this.db.all(
      `SELECT publication_id, receipt FROM publications WHERE request_token = ?`,
      [requestToken],
      (err, result) => {
        if (err) return callback(err);
        if (result && result.length > 0) {
          callback(null, {
            publication_id: result[0].publication_id,
            receipt: JSON.parse(result[0].receipt),
          });
        } else {
          callback(null, null);
        }
      }
    );
  }

  /**
   * Store publication receipt
   */
  store(requestToken, bundleId, publicationId, receipt, callback) {
    this.db.run(
      `INSERT OR REPLACE INTO publications (request_token, bundle_id, publication_id, receipt)
       VALUES (?, ?, ?, ?)`,
      [requestToken, bundleId, publicationId, JSON.stringify(receipt)],
      (err) => {
        callback(err);
      }
    );
  }

  /**
   * Close database connection
   */
  close(callback) {
    if (this.db) {
      this.db.close(callback);
    } else {
      callback();
    }
  }
}

module.exports = { PublicationDB };

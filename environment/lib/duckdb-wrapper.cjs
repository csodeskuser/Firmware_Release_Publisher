/**
 * DuckDB wrapper for CommonJS
 * Handles DuckDB initialization and provides sync/async methods
 * Works with Node 20 LTS which has proper DuckDB support
 */

const Database = require('duckdb').Database;
const fs = require('fs');

class DuckDBWrapper {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
  }

  /**
   * Initialize publications table
   */
  initPublicationsTable() {
    return new Promise((resolve, reject) => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS publications (
          request_token TEXT PRIMARY KEY,
          bundle_id TEXT NOT NULL,
          publication_id TEXT NOT NULL,
          receipt TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Load CSV and perform SQL reconciliation
   */
  reconcileManifest(csvPath) {
    return new Promise((resolve, reject) => {
      const normalizedPath = csvPath.replace(/\\/g, '/');

      this.db.run(
        `CREATE TEMP TABLE raw_manifest AS SELECT * FROM read_csv_auto('${normalizedPath}', header=true)`,
        (err) => {
          if (err) return reject(err);

          this.db.all('SELECT COUNT(*) as total FROM raw_manifest', (err, rows) => {
            if (err) return reject(err);
            const totalRows = rows[0].total;

            this.db.all(
              'SELECT COUNT(*) as cnt FROM (SELECT DISTINCT * FROM raw_manifest)',
              (err, rows) => {
                if (err) return reject(err);
                const distinctRows = rows[0].cnt;

                console.log(`[Reconciliation] CSV rows: ${totalRows}, after dedup: ${distinctRows}`);

                this.db.all(
                  `SELECT COUNT(DISTINCT supersedes_id) as cnt FROM raw_manifest 
                   WHERE record_type = 'WITHDRAWAL' AND supersedes_id != ''`,
                  (err, rows) => {
                    if (err) return reject(err);
                    const withdrawnCount = rows[0].cnt;

                    console.log(`[Reconciliation] Withdrawn entries: ${withdrawnCount}`);

                    this.db.run(
                      `CREATE TABLE IF NOT EXISTS publishable_bundles AS
                       WITH deduplicated AS (
                         SELECT DISTINCT * FROM raw_manifest
                       ),
                       withdrawn_ids AS (
                         SELECT DISTINCT supersedes_id as entry_id 
                         FROM deduplicated
                         WHERE record_type = 'WITHDRAWAL' AND supersedes_id != ''
                       ),
                       active_builds AS (
                         SELECT * FROM deduplicated
                         WHERE record_type = 'BUILD' 
                           AND entry_id NOT IN (SELECT entry_id FROM withdrawn_ids)
                       ),
                       bundle_summary AS (
                         SELECT 
                           bundle_id,
                           COUNT(*) as artifact_count,
                           CAST(SUM(CAST(size_bytes AS BIGINT)) AS BIGINT) as total_bytes
                         FROM active_builds
                         GROUP BY bundle_id
                       )
                       SELECT * FROM bundle_summary
                       WHERE artifact_count > 0
                       ORDER BY bundle_id ASC`,
                      (err) => {
                        if (err) return reject(err);

                        this.db.all(
                          `WITH withdrawn AS (
                             SELECT DISTINCT supersedes_id FROM raw_manifest 
                             WHERE record_type = 'WITHDRAWAL' AND supersedes_id != ''
                           )
                           SELECT COUNT(DISTINCT entry_id) as cnt 
                           FROM raw_manifest 
                           WHERE record_type = 'BUILD' 
                             AND entry_id NOT IN (SELECT * FROM withdrawn)`,
                          (err, rows) => {
                            if (err) return reject(err);
                            const activeCount = rows[0].cnt;
                            console.log(`[Reconciliation] Active builds after withdrawal: ${activeCount}`);

                            this.db.all(
                              'SELECT * FROM publishable_bundles ORDER BY bundle_id',
                              (err, bundles) => {
                                if (err) return reject(err);

                                // Convert BigInt to Number for JSON serialization
                                const normalizedBundles = bundles.map(b => ({
                                  bundle_id: b.bundle_id,
                                  artifact_count: Number(b.artifact_count),
                                  total_bytes: Number(b.total_bytes),
                                }));

                                console.log(`[Reconciliation] Publishable bundles: ${normalizedBundles.length}`);
                                normalizedBundles.forEach((b) => {
                                  console.log(
                                    `  - ${b.bundle_id}: ${b.artifact_count} artifacts, ${b.total_bytes} bytes`
                                  );
                                });

                                resolve(normalizedBundles);
                              }
                            );
                          }
                        );
                      }
                    );
                  }
                );
              }
            );
          });
        }
      );
    });
  }

  /**
   * Get publication by token
   */
  getPublicationByToken(requestToken) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT publication_id, receipt FROM publications WHERE request_token = ?',
        [requestToken],
        (err, rows) => {
          if (err) return reject(err);
          if (rows && rows.length > 0) {
            resolve({
              publication_id: rows[0].publication_id,
              receipt: JSON.parse(rows[0].receipt),
            });
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  /**
   * Store publication
   */
  storePublication(requestToken, bundleId, publicationId, receipt) {
    return new Promise((resolve, reject) => {
      // Escape single quotes in JSON
      const escapedReceipt = JSON.stringify(receipt).replace(/'/g, "''");
      
      const query = `INSERT OR REPLACE INTO publications (request_token, bundle_id, publication_id, receipt)
         VALUES ('${requestToken}', '${bundleId}', '${publicationId}', '${escapedReceipt}')`;
      
      this.db.run(query, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Close database
   */
  close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

module.exports = { DuckDBWrapper };

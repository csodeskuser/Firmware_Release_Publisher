#!/usr/bin/env node
/**
 * Firmware Release Publisher
 * 
 * Resolves key rotation issue by:
 * 1. Reconciling build manifest using DuckDB SQL
 * 2. Fetching current signing key metadata from gateway
 * 3. Creating canonical descriptors and CMS signatures with CURRENT key
 * 4. Publishing to distribution gateway with idempotency
 * 5. Persisting receipts in DuckDB for reproducibility
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('duckdb').Database;

const ROOT = path.resolve(__dirname, '..');

// Configuration
const CONFIG = {
  GATEWAY_URL: 'http://127.0.0.1:7070',
  MANIFEST_CSV: path.join(ROOT, 'fixtures', 'build_manifest.csv'),
  DB_PATH: path.join(ROOT, 'releases.duckdb'),
  CURRENT_CERT: process.env.CURRENT_CERT_PATH || path.join(ROOT, 'keys', 'current', 'current.cert.pem'),
  CURRENT_KEY: path.join(ROOT, 'keys', 'current', 'current.key.pem'),
};

// ============================================================================
// DATABASE INITIALIZATION & OPERATIONS
// ============================================================================

/**
 * Initialize DuckDB database and create schema
 */
function initializeDatabase() {
  const db = new Database(CONFIG.DB_PATH);
  
  // Create publications table for idempotency tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS publications (
      request_token TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      receipt TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  return db;
}

/**
 * Get publication by request token (for idempotency)
 */
function getPublicationByToken(db, requestToken) {
  try {
    const result = db.all(`
      SELECT publication_id, receipt FROM publications WHERE request_token = ?
    `, [requestToken]);
    
    if (result && result.length > 0) {
      return {
        publication_id: result[0].publication_id,
        receipt: JSON.parse(result[0].receipt),
      };
    }
  } catch (e) {
    // Table might not exist yet or query failed
  }
  return null;
}

/**
 * Store a publication receipt in DuckDB
 */
function storePublication(db, requestToken, bundleId, publicationId, receipt) {
  try {
    db.run(`
      INSERT OR REPLACE INTO publications (request_token, bundle_id, publication_id, receipt)
      VALUES (?, ?, ?, ?)
    `, [requestToken, bundleId, publicationId, JSON.stringify(receipt)]);
  } catch (e) {
    console.error('[DB] Insert failed:', e.message);
    throw e;
  }
}

// ============================================================================
// CSV LOADING & SQL-BASED RECONCILIATION (DUCKDB)
// ============================================================================

/**
 * Load CSV into DuckDB and perform reconciliation via SQL
 */
function reconcileViaSQL(db) {
  console.log('[Reconciliation] Loading CSV manifest into DuckDB...');
  
  try {
    // Use DuckDB's read_csv_auto to load CSV directly
    const csvPath = CONFIG.MANIFEST_CSV.replace(/\\/g, '/');
    
    // Create temporary table from CSV
    db.run(`
      CREATE TEMP TABLE raw_manifest AS 
      SELECT * FROM read_csv_auto('${csvPath}')
    `);
    
    // Count total rows
    const totalRows = db.all(`SELECT COUNT(*) as cnt FROM raw_manifest`)[0].cnt;
    
    // Count distinct rows (deduplication)
    const distinctCount = db.all(`
      SELECT COUNT(*) as cnt FROM (
        SELECT DISTINCT * FROM raw_manifest
      ) t
    `)[0].cnt;
    
    console.log(`[Reconciliation] CSV rows: ${totalRows}, after dedup: ${distinctCount}`);
    
    // Query: Identify withdrawn entries
    const withdrawnCount = db.all(`
      SELECT COUNT(DISTINCT supersedes_id) as cnt FROM (
        SELECT DISTINCT supersedes_id FROM raw_manifest 
        WHERE record_type = 'WITHDRAWAL' AND length(supersedes_id) > 0
      ) t
    `)[0].cnt;
    
    console.log(`[Reconciliation] Withdrawn entries: ${withdrawnCount}`);
    
    // Query: Calculate active builds
    const activeBuildCount = db.all(`
      SELECT COUNT(DISTINCT entry_id) as cnt FROM (
        WITH withdrawn_ids AS (
          SELECT DISTINCT supersedes_id FROM raw_manifest
          WHERE record_type = 'WITHDRAWAL' AND length(supersedes_id) > 0
        )
        SELECT DISTINCT entry_id FROM raw_manifest
        WHERE record_type = 'BUILD' 
          AND entry_id NOT IN (SELECT * FROM withdrawn_ids)
      ) t
    `)[0].cnt;
    
    console.log(`[Reconciliation] Active builds after withdrawal: ${activeBuildCount}`);
    
    // Create final publishable bundles table via SQL reconciliation
    db.run(`
      CREATE TABLE publishable_bundles AS
      WITH deduplicated AS (
        SELECT DISTINCT * FROM raw_manifest
      ),
      withdrawn_ids AS (
        SELECT DISTINCT supersedes_id as entry_id 
        FROM deduplicated
        WHERE record_type = 'WITHDRAWAL' AND length(supersedes_id) > 0
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
      ORDER BY bundle_id ASC
    `);
    
    // Fetch publishable bundles
    const bundles = db.all(`SELECT * FROM publishable_bundles`);
    
    console.log(`[Reconciliation] Publishable bundles: ${bundles.length}`);
    bundles.forEach(b => {
      console.log(`  - ${b.bundle_id}: ${b.artifact_count} artifacts, ${b.total_bytes} bytes`);
    });
    
    return bundles;
  } catch (e) {
    console.error('[Reconciliation] Error:', e.message);
    throw e;
  }
}

// ============================================================================
// SIGNING & CANONICALIZATION
// ============================================================================

/**
 * Create canonical descriptor: sorted JSON keys, no whitespace
 */
function canonicalizeDescriptor(bundleData) {
  const descriptor = {
    artifact_count: bundleData.artifact_count,
    bundle_id: bundleData.bundle_id,
    total_bytes: bundleData.total_bytes,
  };
  
  // Sort keys lexicographically and stringify without spaces
  const sorted = {};
  Object.keys(descriptor).sort().forEach(key => {
    sorted[key] = descriptor[key];
  });
  
  return JSON.stringify(sorted);
}

/**
 * Create detached CMS signature using OpenSSL
 * Returns PEM-formatted signature
 */
function signDescriptor(descriptor) {
  // Use temp directory for files
  let tmpFile;
  if (process.platform === 'win32') {
    tmpFile = path.join(process.env.TEMP || process.env.TMP || 'C:\\temp', 
      `descriptor-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  } else {
    tmpFile = path.join('/tmp', 
      `descriptor-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  }
  
  try {
    fs.writeFileSync(tmpFile, descriptor, 'utf-8');
    
    // Create signature
    const result = spawnSync('openssl', [
      'cms',
      '-sign',
      '-in', tmpFile,
      '-signer', CONFIG.CURRENT_CERT,
      '-inkey', CONFIG.CURRENT_KEY,
      '-outform', 'PEM',
      '-binary',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        OPENSSL_CONF: process.env.OPENSSL_CONF,
      },
    });
    
    if (result.status !== 0) {
      throw new Error(`OpenSSL signing failed: ${result.stderr}`);
    }
    
    return result.stdout;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// GATEWAY INTEGRATION (using native fetch)
// ============================================================================

/**
 * Fetch current signing key metadata from gateway
 */
async function fetchCurrentKeyMetadata() {
  const response = await fetch(`${CONFIG.GATEWAY_URL}/v1/signing-key/current`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch key metadata: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Submit signed descriptor to gateway
 */
async function publishDescriptor(descriptor, signature, requestToken) {
  const payload = {
    descriptor,
    signature,
    request_token: requestToken,
  };
  
  const response = await fetch(`${CONFIG.GATEWAY_URL}/v1/publications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Publication failed: ${error.error || response.statusText}`);
  }
  
  return response.json();
}

// ============================================================================
// MAIN PUBLISHER LOGIC
// ============================================================================

async function publishBundles() {
  console.log('[Publisher] Starting firmware release publisher');
  console.log(`[Publisher] Gateway: ${CONFIG.GATEWAY_URL}`);
  console.log(`[Publisher] Manifest: ${CONFIG.MANIFEST_CSV}`);
  console.log(`[Publisher] Current cert: ${CONFIG.CURRENT_CERT}`);
  console.log(`[Publisher] Database: ${CONFIG.DB_PATH}`);
  console.log('');
  
  // Initialize DuckDB
  const db = initializeDatabase();
  
  try {
    // Perform SQL-based reconciliation
    console.log('[Publisher] Reading and reconciling build manifest...');
    const bundles = reconcileViaSQL(db);
    console.log('');
    
    if (bundles.length === 0) {
      console.log('[Publisher] No publishable bundles found');
      return;
    }
    
    // Fetch gateway key metadata
    console.log('[Publisher] Fetching current signing key metadata...');
    const keyMetadata = await fetchCurrentKeyMetadata();
    console.log(`[Publisher] Current key: ${keyMetadata.key_id}`);
    console.log(`[Publisher] Algorithm: ${keyMetadata.algorithm}`);
    console.log('');
    
    // Process each bundle
    const results = [];
    
    for (const bundle of bundles) {
      const requestToken = `token-${bundle.bundle_id}`;
      console.log(`[Publisher] Processing bundle: ${bundle.bundle_id}`);
      
      // Check for idempotent replay
      const existing = getPublicationByToken(db, requestToken);
      if (existing) {
        console.log(`[Publisher]   Already published, using existing receipt`);
        const receipt = existing.receipt;
        results.push({
          bundle: bundle.bundle_id,
          keyId: keyMetadata.key_id,
          publicationId: existing.publication_id,
          requestToken,
          status: receipt.status,
        });
        continue;
      }
      
      // Create canonical descriptor
      const descriptor = canonicalizeDescriptor(bundle);
      console.log(`[Publisher]   Descriptor: ${descriptor.substring(0, 60)}...`);
      
      // Sign with CURRENT key
      console.log(`[Publisher]   Creating CMS signature with CURRENT key...`);
      const signature = signDescriptor(descriptor);
      console.log(`[Publisher]   Signature created (${signature.length} bytes)`);
      
      // Publish to gateway
      console.log(`[Publisher]   Publishing to gateway...`);
      const receipt = await publishDescriptor(descriptor, signature, requestToken);
      
      if (receipt.status === 'PUBLISHED') {
        console.log(`[Publisher]   ✓ Published with receipt: ${receipt.publication_id}`);
        
        // Store in DuckDB
        storePublication(db, requestToken, bundle.bundle_id, receipt.publication_id, receipt);
        
        results.push({
          bundle: bundle.bundle_id,
          keyId: keyMetadata.key_id,
          publicationId: receipt.publication_id,
          requestToken,
          status: receipt.status,
        });
      } else {
        throw new Error(`Unexpected receipt status: ${receipt.status}`);
      }
    }
    
    // Generate output
    console.log('');
    console.log('[Publisher] Publication Results:');
    console.log('');
    
    for (const result of results) {
      console.log(`BUNDLE ${result.bundle} SIGNED KEY=${result.keyId}`);
      console.log(`BUNDLE ${result.bundle} PUBLISHED RECEIPT=${result.publicationId} TOKEN=${result.requestToken} STATUS=${result.status}`);
    }
    
  } catch (error) {
    console.error('[Publisher] Error:', error.message);
    throw error;
  } finally {
    try {
      db.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

publishBundles().catch(error => {
  console.error('[Publisher] Fatal error:', error.message);
  process.exit(1);
});

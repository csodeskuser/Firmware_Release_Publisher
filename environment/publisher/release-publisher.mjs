#!/usr/bin/env node
/**
 * Firmware Release Publisher
 * 
 * Implementation following CANDIDATE_GUIDE.md:
 * 1. Load CSV into DuckDB and reconcile using SQL
 * 2. Sign with CURRENT key using OpenSSL CMS
 * 3. Publish to gateway over HTTP
 * 4. Persist receipts in DuckDB for idempotency
 * 5. Generate deterministic output
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

// Import DuckDB wrapper via CommonJS
const require = createRequire(import.meta.url);
const { DuckDBWrapper } = require('../lib/duckdb-wrapper.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
// STEP 2: SIGNING WITH OPENSSL CMS
// ============================================================================

/**
 * Create canonical descriptor (sorted keys, no whitespace)
 */
function canonicalizeDescriptor(bundleData) {
  const descriptor = {
    artifact_count: bundleData.artifact_count,
    bundle_id: bundleData.bundle_id,
    total_bytes: bundleData.total_bytes,
  };
  
  // Sort keys lexicographically
  const sorted = {};
  Object.keys(descriptor).sort().forEach(key => {
    sorted[key] = descriptor[key];
  });
  
  return JSON.stringify(sorted);
}

/**
 * Sign descriptor with OpenSSL CMS (detached signature)
 */
function signDescriptor(descriptor) {
  // Write descriptor to temp file
  let tmpFile;
  if (process.platform === 'win32') {
    tmpFile = path.join(process.env.TEMP || 'C:\\temp', `desc-${Date.now()}.bin`);
  } else {
    tmpFile = `/tmp/desc-${Date.now()}.bin`;
  }
  
  try {
    fs.writeFileSync(tmpFile, descriptor, 'utf-8');
    
    // Sign with OpenSSL CMS using CURRENT key
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
      env: process.env,
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
// STEP 3: GATEWAY INTEGRATION
// ============================================================================

/**
 * Fetch current signing key metadata
 */
async function fetchCurrentKeyMetadata() {
  const response = await fetch(`${CONFIG.GATEWAY_URL}/v1/signing-key/current`);
  if (!response.ok) {
    throw new Error(`Failed to fetch key metadata: ${response.status}`);
  }
  return response.json();
}

/**
 * Publish signed descriptor to gateway
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
  console.log(`[Publisher] Database: ${CONFIG.DB_PATH}`);
  console.log(`[Publisher] Current cert: ${CONFIG.CURRENT_CERT}`);
  console.log('');
  
  // Initialize DuckDB
  const db = new DuckDBWrapper(CONFIG.DB_PATH);
  
  try {
    // Step 4: Initialize publications table for idempotency
    await db.initPublicationsTable();
    
    // Step 1: Reconcile manifest using SQL
    console.log('[Publisher] Reading and reconciling build manifest...');
    const bundles = await db.reconcileManifest(CONFIG.MANIFEST_CSV);
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
    
    // Step 3: Process each bundle
    const results = [];
    
    for (const bundle of bundles) {
      const requestToken = `token-${bundle.bundle_id}`;
      console.log(`[Publisher] Processing bundle: ${bundle.bundle_id}`);
      
      // Check for idempotent replay (Step 4)
      const existing = await db.getPublicationByToken(requestToken);
      
      if (existing) {
        console.log(`[Publisher]   Already published, using existing receipt`);
        results.push({
          bundle: bundle.bundle_id,
          keyId: keyMetadata.key_id,
          publicationId: existing.publication_id,
          requestToken,
          status: existing.receipt.status,
        });
        continue;
      }
      
      // Step 2: Create canonical descriptor and sign
      const descriptor = canonicalizeDescriptor(bundle);
      console.log(`[Publisher]   Descriptor: ${descriptor.substring(0, 60)}...`);
      
      console.log(`[Publisher]   Creating CMS signature with CURRENT key...`);
      const signature = signDescriptor(descriptor);
      console.log(`[Publisher]   Signature created (${signature.length} bytes)`);
      
      // Step 3: Publish to gateway
      console.log(`[Publisher]   Publishing to gateway...`);
      const receipt = await publishDescriptor(descriptor, signature, requestToken);
      
      if (receipt.status === 'PUBLISHED') {
        console.log(`[Publisher]   ✓ Published with receipt: ${receipt.publication_id}`);
        
        // Step 4: Store in DuckDB
        await db.storePublication(requestToken, bundle.bundle_id, receipt.publication_id, receipt);
        
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
    
    // Step 5: Generate deterministic output
    console.log('');
    console.log('[Publisher] Publication Results:');
    console.log('');
    
    for (const result of results) {
      console.log(`BUNDLE ${result.bundle} SIGNED KEY=${result.keyId}`);
      console.log(`BUNDLE ${result.bundle} PUBLISHED RECEIPT=${result.publicationId} TOKEN=${result.requestToken} STATUS=${result.status}`);
    }
    
  } catch (error) {
    console.error('[Publisher] Fatal error:', error.message);
    throw error;
  } finally {
    await db.close();
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

publishBundles().catch(error => {
  console.error('[Publisher] Error:', error.message);
  process.exit(1);
});

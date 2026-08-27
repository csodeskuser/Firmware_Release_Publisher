#!/usr/bin/env pwsh
# Set environment variables
$env:PATH = "C:\Program Files\OpenSSL-Win64\bin;$env:PATH"
$env:OPENSSL_CONF = "C:\Program Files\OpenSSL-Win64\bin\cnf\openssl.cnf"
$env:CURRENT_CERT_PATH = "e:\skeleton\environment\keys\current\current.cert.pem"

# Navigate to gateway directory
cd e:\skeleton\environment\distribution-gateway

# Start the gateway
npm start

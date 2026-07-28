#!/bin/bash
cd /root/Athena-Search

# Load .env file
set -a
source .env
set +a

# Start the server
exec node server/index.js

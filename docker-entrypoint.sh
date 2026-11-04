#!/bin/sh
# Prepare the database, then hand over to the server.
#
# bootstrap.js applies the schema and seeds only when the database has no
# users, so this is safe to run on every container start: a redeploy never
# wipes data that is already there.

set -e

node server/db/bootstrap.js

exec "$@"

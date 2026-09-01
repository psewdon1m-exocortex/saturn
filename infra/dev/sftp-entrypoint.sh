#!/bin/sh
set -eu

cp /hostkeys/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key
chmod 0600 /etc/ssh/ssh_host_ed25519_key
exec /entrypoint

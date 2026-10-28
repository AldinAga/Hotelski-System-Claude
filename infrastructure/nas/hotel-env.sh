#!/usr/bin/env bash
# Runs ON THE NAS (deploy.sh runs the copy from the deployed ref,
# /volume1/ci/hotel/deploy/infrastructure/nas/hotel-env.sh). Completes
# /volume1/ci/hotel/hotel.env for hotel-api, add-only:
#
#   HOTEL_SECRET_KEY   32 random bytes, base64url; made once, never changed
#                      (it encrypts the installation's private key in the database)
#   HOTEL_ROOT_KEYSET  GET http://192.168.1.199:4100/v1/keys, base64 of the JSON,
#                      pinned once
#   DATABASE_URL       postgres://<user>:<password>@hotel-postgres-claude:5432/<db>,
#                      built from the HOTEL_POSTGRES_* lines already in the file
#
# A key that is already present is never rewritten; a key whose line has an
# empty value stops the script (see has/blank below). No value is ever printed:
# the script reports key names only. The file stays mode 600.
set -euo pipefail
umask 077

F=/volume1/ci/hotel/hotel.env
KEYS_URL=http://192.168.1.199:4100/v1/keys

if [ ! -f "$F" ]; then
  echo "   $F does not exist; it is created once by hand (see CLAUDE.md)" >&2
  exit 1
fi

# Without a final newline the first appended line would be glued onto the last
# existing value (and change a password); end the file with one first.
if [ -s "$F" ] && [ -n "$(tail -c1 "$F")" ]; then printf '\n' >> "$F"; fi

# A key counts as present only with a non-blank value. A line that names the key
# but has no value (`KEY=` or `KEY=   `) is neither kept nor rewritten: a second
# `KEY=` line would leave two definitions whose winner depends on the reader,
# and editing the file in place is exactly what this script never does. So it
# stops and names the key (never a value); a person removes that line by hand.
has() { grep -q "^$1=[^[:space:]]" "$F"; }
blank() { grep -q "^$1=[[:space:]]*$" "$F"; }
val() { grep -m1 "^$1=" "$F" | cut -d= -f2-; }

for k in HOTEL_SECRET_KEY HOTEL_ROOT_KEYSET DATABASE_URL; do
  if ! has "$k" && blank "$k"; then
    echo "   $k is in $F with an empty value; remove that line by hand and deploy again" >&2
    exit 1
  fi
done

if has HOTEL_SECRET_KEY; then
  echo "   HOTEL_SECRET_KEY present, kept"
else
  key="$(head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  if [ "${#key}" -ne 43 ]; then echo "   could not generate HOTEL_SECRET_KEY" >&2; exit 1; fi
  printf 'HOTEL_SECRET_KEY=%s\n' "$key" >> "$F"
  unset key
  echo "   HOTEL_SECRET_KEY added"
fi

if has HOTEL_ROOT_KEYSET; then
  echo "   HOTEL_ROOT_KEYSET present, kept"
else
  keyset="$(curl -sf --max-time 20 "$KEYS_URL")" || { echo "   $KEYS_URL is not reachable" >&2; exit 1; }
  if ! printf '%s' "$keyset" | grep -q '"type":"keyset"'; then
    echo "   $KEYS_URL did not answer with a signed key set" >&2
    exit 1
  fi
  printf 'HOTEL_ROOT_KEYSET=%s\n' "$(printf '%s' "$keyset" | base64 -w0)" >> "$F"
  unset keyset
  echo "   HOTEL_ROOT_KEYSET added"
fi

if has DATABASE_URL; then
  echo "   DATABASE_URL present, kept"
else
  user="$(val HOTEL_POSTGRES_USER)"
  pass="$(val HOTEL_POSTGRES_PASSWORD)"
  db="$(val HOTEL_POSTGRES_DB)"
  # Only URL-safe values go into a URL unescaped.
  for part in "$user" "$pass" "$db"; do
    case "$part" in
      '' | *[!A-Za-z0-9_-]*)
        echo "   HOTEL_POSTGRES_USER/PASSWORD/DB missing or not URL-safe; DATABASE_URL not written" >&2
        exit 1
        ;;
    esac
  done
  printf 'DATABASE_URL=postgres://%s:%s@hotel-postgres-claude:5432/%s\n' "$user" "$pass" "$db" >> "$F"
  unset user pass db
  echo "   DATABASE_URL added"
fi

chmod 600 "$F"
echo "   hotel.env keys: $(grep -v '^#' "$F" | grep '=' | cut -d= -f1 | tr '\n' ' ')"

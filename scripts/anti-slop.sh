#!/usr/bin/env bash
set -euo pipefail
# Local anti-slop gate — same vocabulary as CI, runs before commit / open pr.
# Ignores vendor skill bundles (.agents/, skills-lock) and its own regex definition.
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TMP=/tmp/anti-slop-diff.txt
  git diff --cached -- ':!.agents' ':!skills-lock.json' ':!package-lock.json' ':!scripts/anti-slop.sh' > "$TMP" 2>/dev/null || true
  # also drop diff headers that contain the regex literal itself
  grep -v 'SLOP_REGEX' "$TMP" > "${TMP}.filtered" 2>/dev/null || true
  TARGET="${TMP}.filtered"
else
  grep -v 'SLOP_REGEX' "$TARGET" > /tmp/anti-slop-target.filtered 2>/dev/null || true
  TARGET=/tmp/anti-slop-target.filtered
fi
SLOP_REGEX='(delve|crucial|robust|seamless|leverage|tapestry|meticulous(ly)?|unveil|embark|game-changer|cutting-edge|state-of-the-art|empower|synergy|granular|comprehensive|holistic|best-of-breed|streamline|innovative|forward-thinking|in today.s fast-paced|in conclusion|it.s important to note|whether you.re a seasoned|supercharge|harness the power|effortlessly|dive into|dive deep|elevate|unleash|let.s unlock|beyond just|not only\.\.\.but also)'
if grep -i -E -n "$SLOP_REGEX" "$TARGET" 2>/dev/null | head -n 50; then
  echo "Anti-slop: found AI tells — rewrite with plain language (stop-slop skill) before committing." >&2
  # only fail on non-vendor content
  if [ -s "$TARGET" ]; then
    # check if hits are outside vendor — we already filtered vendor, so any hit is real
    exit 1
  fi
fi
echo "Anti-slop: clean."

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
SLOP_REGEX='(\bdelve\b|\bcrucial\b|\brobust\b|\bseamless\b|\bleverage\b|\btapestry\b|\bmeticulous(ly)?\b|\bunveil\b|\bembark\b|\bgame-changer\b|\bcutting-edge\b|\bstate-of-the-art\b|\bempower\b|\bsynergy\b|\bgranular\b|\bcomprehensive\b|\bholistic\b|\bbest-of-breed\b|\bstreamline\b|\binnovative\b|\bforward-thinking\b|\bin today.s fast-paced\b|\bin conclusion\b|\bit.s important to note\b|\bwhether you.re a seasoned\b|\bsupercharge\b|\bharness the power\b|\beffortlessly\b|\bdive into\b|\bdive deep\b|\belevate\b|\bunleash\b|\blet.s unlock\b|\bbeyond just\b|\bnot only\.\.\.but also\b)'
INFRA_REGEX='([a-z0-9_.-]+\.hstgr\.cloud|root@[a-z0-9_.-]+)'
if grep -i -E -n "$SLOP_REGEX" "$TARGET" 2>/dev/null | head -n 50; then
  echo "Anti-slop: found AI tells — rewrite with plain language (stop-slop skill) before committing." >&2
  # only fail on non-vendor content
  if [ -s "$TARGET" ]; then
    # check if hits are outside vendor — we already filtered vendor, so any hit is real
    exit 1
  fi
fi
if grep -i -E -n "$INFRA_REGEX" "$TARGET" 2>/dev/null | grep -v 'INFRA_REGEX' | head -n 50; then
  echo "Anti-leak: found server hostname or root author exposure — remove before committing." >&2
  if [ -s "$TARGET" ]; then
    exit 1
  fi
fi
echo "Anti-slop: clean."

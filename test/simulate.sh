#!/usr/bin/env bash
# End-to-end simulation of the PR loop against a local bare "origin".
# Exercises: preview on open, apply on merge, dedupe, second PR, release cut.
# No GitHub, no API key. Usage: test/simulate.sh [provider]
set -euo pipefail

ACTION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVIDER="${1:-mock}"
SIM="${SIM_DIR:-/tmp/pbcl-sim}"

rm -rf "$SIM"; mkdir -p "$SIM"
git init -q --bare "$SIM/origin.git"
git clone -q "$SIM/origin.git" "$SIM/work"
cd "$SIM/work"
git config user.name sim; git config user.email sim@example.com
git symbolic-ref HEAD refs/heads/main

mkdir -p src
echo "console.log('hello');" > src/index.js
git add -A; git commit -qm "chore: init"; git push -q -u origin main

export GITHUB_REPOSITORY="acme/demo"
export GITHUB_WORKSPACE="$SIM/work"
export GITHUB_OUTPUT="$SIM/outputs.txt"
export GITHUB_STEP_SUMMARY="$SIM/summary.md"
export INPUT_LLM_PROVIDER="$PROVIDER"
export INPUT_GITHUB_TOKEN=""       # empty => preview prints to stdout instead of commenting
export INPUT_DOCS_DIR="docs"
export INPUT_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export INPUT_OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export INPUT_LLM_MODEL="${LLM_MODEL:-}"

event() { export GITHUB_EVENT_PATH="$SIM/event.json"; printf '%s' "$1" > "$GITHUB_EVENT_PATH"; }
run()   { node "$ACTION_DIR/scripts/main.js"; }
rule()  { printf '\n\033[1;35m=== %s ===\033[0m\n' "$1"; }

# ---------------------------------------------------------------- PR #12 open
rule "PR #12 opened — preview only, nothing written"
git checkout -qb feat/redis
cat > src/session.js <<'EOF'
const url = process.env.REDIS_URL;
export const cache = createRedisClient(url);
EOF
git add -A; git commit -qm "feat: cache sessions in redis"; git push -q -u origin feat/redis
BASE_SHA=$(git rev-parse origin/main)

event "{\"action\":\"opened\",\"pull_request\":{\"number\":12,\"title\":\"Add Redis cache to session store\",\"body\":\"Introduces a new REDIS_URL env var that must be set in every environment.\\n\\nWalkthrough: https://www.loom.com/share/redis123\",\"user\":{\"login\":\"akram\"},\"base\":{\"ref\":\"main\",\"sha\":\"$BASE_SHA\"},\"head\":{\"sha\":\"$(git rev-parse HEAD)\"},\"merged\":false}}"
run
echo "--- docs/ after preview (expect: absent) ---"; ls docs 2>/dev/null || echo "(no docs dir — correct, preview writes nothing)"

# --------------------------------------------------------------- PR #12 merge
rule "PR #12 merged — apply mode writes + pushes"
git checkout -q main; git merge -q --no-ff feat/redis -m "Merge pull request #12"; git push -q origin main
MERGE_SHA=$(git rev-parse HEAD)
event "{\"action\":\"closed\",\"pull_request\":{\"number\":12,\"title\":\"Add Redis cache to session store\",\"body\":\"Introduces a new REDIS_URL env var that must be set in every environment.\\n\\nWalkthrough: https://www.loom.com/share/redis123\",\"base\":{\"ref\":\"main\",\"sha\":\"$BASE_SHA\"},\"head\":{\"sha\":\"$MERGE_SHA\"},\"merged\":true,\"merge_commit_sha\":\"$MERGE_SHA\"}}"
run
git -C "$SIM/work" fetch -q origin main && git -C "$SIM/work" reset -q --hard origin/main
echo "--- docs/changelog.md ---"; cat docs/changelog.md

# ------------------------------------------------------------- rerun = no-op
rule "Same event replayed — must be idempotent (no second entry)"
run

# ---------------------------------------------------------------- PR #13 loop
rule "PR #13 merged — second unreleased entry, different section"
BASE_SHA=$(git rev-parse origin/main)
git checkout -qb feat/audit
cat > src/audit.js <<'EOF'
export function auditLog(event) {
  logger.info({ kind: 'audit', ...event });
}
EOF
git add -A; git commit -qm "feat: structured audit logging"; git push -q -u origin feat/audit
git checkout -q main; git merge -q --no-ff feat/audit -m "Merge pull request #13"; git push -q origin main
MERGE_SHA=$(git rev-parse HEAD)
event "{\"action\":\"closed\",\"pull_request\":{\"number\":13,\"title\":\"Add structured audit logging\",\"body\":\"Emits audit events to the central logger for incident review.\\n\\nWalkthrough: https://www.loom.com/share/audit456\",\"base\":{\"ref\":\"main\",\"sha\":\"$BASE_SHA\"},\"head\":{\"sha\":\"$MERGE_SHA\"},\"merged\":true,\"merge_commit_sha\":\"$MERGE_SHA\"}}"
run
git fetch -q origin main && git reset -q --hard origin/main

# ---------------------------------------------------------------- video gate
rule "PR #14 opened with NO video link — suggested, never blocked"
BASE_SHA=$(git rev-parse origin/main)
git checkout -qb feat/novideo
echo "export const flag = true;" > src/flag.js
git add -A; git commit -qm "feat: add feature flag"; git push -q -u origin feat/novideo
event "{\"action\":\"opened\",\"pull_request\":{\"number\":14,\"title\":\"Add feature flag\",\"body\":\"No video on this one.\",\"base\":{\"ref\":\"main\",\"sha\":\"$BASE_SHA\"},\"head\":{\"sha\":\"$(git rev-parse HEAD)\"},\"merged\":false}}"
if run; then echo "OK: exited zero — the PR is not blocked, and the entry above was still produced"; else echo "!!! FAIL: a missing video must not fail the run"; exit 1; fi
git checkout -q main

# ------------------------------------------------------------------- release
rule "Cut release — entries move to a dated file, changelog empties"
node "$ACTION_DIR/scripts/make-release.js" --title "v0.1.0"

rule "FINAL STATE"
echo "--- docs/playbook.md ---"; cat docs/playbook.md
echo "--- docs/changelog.md ---"; cat docs/changelog.md
echo "--- release file ---"; cat docs/release-*.md
echo "--- git log on main ---"; git log --oneline -8

#!/usr/bin/env bash
# chickenflow — commit/push/deploy helper
#
# Usage:
#   chickenflow push                      # commit + push production to GitHub (no deploy)
#   chickenflow push "fix manual mode"    # …with custom commit message
#   chickenflow deploy                    # commit + push + build + image push + rollout + health
#   chickenflow deploy "fix manual mode"  # …with custom commit message
#
# Wire up once with:
#   echo 'chickenflow() { /home/user/chickenFlow/scripts/chickenflow-deploy.sh "$@"; }' >> ~/.bashrc

set -euo pipefail

REPO="/home/user/chickenFlow"
BRANCH="production"
NAMESPACE="chickenflow"
IMAGE="ghcr.io/ivemcfire/chickenflow"

cd "$REPO"

cmd="${1:-deploy}"
shift || true

case "$cmd" in
  push|deploy) ;;
  *)
    echo "Usage: chickenflow {push|deploy} [commit message]" >&2
    exit 2
    ;;
esac

default_msg_prefix="$cmd"
msg="${1:-$default_msg_prefix: $(date -u +%Y-%m-%dT%H:%M:%SZ)}"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. Sanity: branch must be production ─────────────────────────────────────
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "$BRANCH" ]]; then
  fail "Must be on '$BRANCH' branch (currently on '$current_branch'). Refusing to $cmd."
fi

# ── 2. Commit any pending changes ────────────────────────────────────────────
step "Checking for uncommitted changes"
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -m "$msg"
  ok "Committed: $msg"
else
  ok "Working tree clean"
fi

# ── 3. Push to GitHub ────────────────────────────────────────────────────────
step "Pushing to origin/$BRANCH"
git push origin "$BRANCH"
ok "Pushed to GitHub"

# `push` stops here — no build, no rollout.
if [[ "$cmd" == "push" ]]; then
  SHA=$(git rev-parse --short HEAD)
  ok "chickenflow $SHA pushed to origin/$BRANCH. Run 'chickenflow deploy' to roll out."
  exit 0
fi

SHA=$(git rev-parse --short HEAD)

# ── 4. Build & push Docker image (tagged latest + sha) ───────────────────────
step "Building Docker image ($IMAGE:$SHA)"
docker build -t "$IMAGE:latest" -t "$IMAGE:$SHA" ./chickenFlow
ok "Image built"

step "Pushing image to ghcr.io"
docker push "$IMAGE:latest"
docker push "$IMAGE:$SHA"
ok "Image pushed"

# ── 5. Apply manifests + rollout ─────────────────────────────────────────────
step "Applying k3s manifests"
kubectl apply -f chickenFlow/deploy/namespace.yaml
kubectl apply -f chickenFlow/deploy/configmap.yaml
kubectl apply -f chickenFlow/deploy/pvc.yaml
kubectl apply -f chickenFlow/deploy/deployment.yaml
kubectl apply -f chickenFlow/deploy/service.yaml
ok "Manifests applied"

step "Rolling deployment to pick up new image"
kubectl set image deployment/chickenflow-backend \
  chickenflow="$IMAGE:$SHA" -n "$NAMESPACE" --record=false || true
kubectl rollout restart deployment/chickenflow-backend -n "$NAMESPACE"
kubectl rollout status deployment/chickenflow-backend -n "$NAMESPACE" --timeout=180s

# ── 6. Health check ──────────────────────────────────────────────────────────
step "Health check"
SVC_IP=$(kubectl get svc chickenflow-svc -n "$NAMESPACE" \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
if [[ -z "$SVC_IP" ]]; then
  SVC_IP=$(kubectl get svc chickenflow-svc -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}')
fi

for i in 1 2 3 4 5; do
  if curl -sf "http://$SVC_IP/api/health" >/dev/null; then
    ok "Health OK at http://$SVC_IP/api/health"
    curl -s "http://$SVC_IP/api/health" | python3 -m json.tool || true
    echo
    ok "chickenflow $SHA deployed."
    exit 0
  fi
  sleep 3
done

fail "Health check failed after rollout. Inspect: kubectl logs -n $NAMESPACE -l app=chickenflow --tail=200"

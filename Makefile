IMAGE     := ghcr.io/ivemcfire/chickenflow
NAMESPACE := chickenflow
DEPLOY    := chickenFlow/deploy

.PHONY: help build push deploy status health logs rollback db-shell restart \
        node-label secret-create verify-first-deploy

help:
	@echo ""
	@echo "ChickenFlow — Ops Targets (Opus lane)"
	@echo "─────────────────────────────────────────────────────────────"
	@echo "  make build               Build Docker image locally"
	@echo "  make push                Push image to ghcr.io"
	@echo "  make deploy              Apply all k3s manifests"
	@echo "  make status              Pod + service status"
	@echo "  make health              Curl /api/health"
	@echo "  make logs                Follow pod logs"
	@echo "  make rollback            Roll back to previous image"
	@echo "  make db-shell            Open SQLite shell on the pod"
	@echo "  make restart             Force pod restart"
	@echo "  make node-label NODE=<name>  Label a node for PVC placement"
	@echo "  make secret-create KEY=sk-ant-...  Create ai-secret"
	@echo "  make verify-first-deploy  Full post-deploy health check"
	@echo ""

# ── Build ─────────────────────────────────────────────────────────────────────

build:
	docker build -t $(IMAGE):latest ./chickenFlow

push:
	docker push $(IMAGE):latest

# ── Deploy ────────────────────────────────────────────────────────────────────

deploy:
	kubectl apply -f $(DEPLOY)/namespace.yaml
	kubectl apply -f $(DEPLOY)/configmap.yaml
	kubectl apply -f $(DEPLOY)/pvc.yaml
	kubectl apply -f $(DEPLOY)/deployment.yaml
	kubectl apply -f $(DEPLOY)/service.yaml
	@echo "Optional ingress: kubectl apply -f $(DEPLOY)/ingress.yaml"

# ── Ops ───────────────────────────────────────────────────────────────────────

status:
	@echo "=== Pods ==="
	kubectl get pods -n $(NAMESPACE) -o wide
	@echo ""
	@echo "=== Services ==="
	kubectl get svc -n $(NAMESPACE)
	@echo ""
	@echo "=== PVC ==="
	kubectl get pvc -n $(NAMESPACE)

health:
	$(eval SVC_IP := $(shell kubectl get svc chickenflow-svc -n $(NAMESPACE) -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || kubectl get svc chickenflow-svc -n $(NAMESPACE) -o jsonpath='{.spec.clusterIP}'))
	curl -sf http://$(SVC_IP)/api/health | python3 -m json.tool

logs:
	kubectl logs -n $(NAMESPACE) -l app=chickenflow -f --tail=100

restart:
	kubectl rollout restart deployment/chickenflow-backend -n $(NAMESPACE)
	kubectl rollout status deployment/chickenflow-backend -n $(NAMESPACE)

rollback:
	kubectl rollout undo deployment/chickenflow-backend -n $(NAMESPACE)
	kubectl rollout status deployment/chickenflow-backend -n $(NAMESPACE)

db-shell:
	$(eval POD := $(shell kubectl get pod -n $(NAMESPACE) -l app=chickenflow -o jsonpath='{.items[0].metadata.name}'))
	kubectl exec -it $(POD) -n $(NAMESPACE) -- sqlite3 /data/chickenflow.db

# ── First-deploy helpers ──────────────────────────────────────────────────────

node-label:
ifndef NODE
	$(error NODE is required: make node-label NODE=<node-name>)
endif
	kubectl label node $(NODE) chickenflow/storage=true --overwrite

secret-create:
ifndef KEY
	$(error KEY is required: make secret-create KEY=sk-ant-...)
endif
	kubectl create secret generic ai-secret \
		--from-literal=api-key=$(KEY) \
		--namespace=$(NAMESPACE) \
		--dry-run=client -o yaml | kubectl apply -f -

verify-first-deploy:
	@echo "1. Pod status..."
	kubectl get pods -n $(NAMESPACE)
	@echo ""
	@echo "2. Health probe..."
	$(eval POD := $(shell kubectl get pod -n $(NAMESPACE) -l app=chickenflow -o jsonpath='{.items[0].metadata.name}'))
	kubectl exec $(POD) -n $(NAMESPACE) -- curl -sf localhost:4000/api/health
	@echo ""
	@echo "3. Settings endpoint..."
	kubectl exec $(POD) -n $(NAMESPACE) -- curl -sf localhost:4000/api/settings | head -c 200
	@echo ""
	@echo "4. Weather cache (populated by startup job)..."
	kubectl exec $(POD) -n $(NAMESPACE) -- curl -sf localhost:4000/api/weather/today
	@echo ""
	@echo "5. AI log (empty on first deploy is OK)..."
	kubectl exec $(POD) -n $(NAMESPACE) -- curl -sf localhost:4000/api/ai/log
	@echo ""
	@echo "Done. Check logs with: make logs"

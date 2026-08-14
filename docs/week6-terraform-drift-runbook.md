# C3 — Terraform Drift Detection Runbook (owner-run)

The credential-free half is already done and committed: `terraform init
-backend=false` + `terraform validate` → *"the configuration is valid"*, `fmt
-check -recursive` clean, provider exact-pinned `render 1.9.1`. The destroy →
apply-from-scratch proof exists from Week 5 (`terraform/render/out/13-14`).

What remains is the **live** drift check, which needs `RENDER_API_KEY` (a live
secret held only by the owner) and — for the destroy half — briefly takes prod
down. Run this yourself; it takes ~5 minutes and produces the evidence.

```bash
cd terraform/render
export RENDER_API_KEY=<your key from dashboard.render.com/settings#api-keys>

# 1. Init with the committed lock file, then a clean plan.
terraform init -input=false
terraform plan -out=drift.tfplan | tee ../../evidence/$(date +%F)/tf-plan-clean.txt
#    Expect: "No changes. Your infrastructure matches the configuration."
#    (that is the "no drift" receipt)

# 2. DEMONSTRATE drift: change one resource out-of-band, then re-plan.
#    e.g. in the Render dashboard, edit the ship-api service's PORT or an
#    env var, or scale the instance. Then:
terraform plan | tee ../../evidence/$(date +%F)/tf-plan-drift.txt
#    Expect: a "~ update in-place" diff naming exactly the field you changed.
#    (that is the "drift detected" receipt)

# 3. Reconcile — terraform pulls it back to the declared state.
terraform apply
#    The field returns to what the config declares; a follow-up `plan` is clean.
```

**Destroy → apply from scratch** (optional refresh; already proven Week 5, and it
takes prod offline for the rebuild — do it only in a maintenance window):
```bash
terraform destroy    # tears the stack down
terraform apply      # rebuilds it identically from the committed config
# Confirm the service comes back: curl https://ship-api-r1om.onrender.com/ready
```

Capture the three `tee`'d files (clean plan, drift plan, reconcile) as the C3
evidence. Nothing here needs code changes — the config is already validated; this
is the live-run proof that only the key-holder can produce.

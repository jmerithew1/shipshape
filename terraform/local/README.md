# terraform/local — drift detection with the `hashicorp/local` provider

A self-contained Terraform configuration that manages **two real local
resources** and demonstrates the full drift-detection loop: declare → apply →
tamper out-of-band → detect → reconcile.

No cloud credentials are used. Nothing outside `terraform/local/` is touched,
so this is safe to run on any machine.

## What it manages

| Resource | Path | Role in the demo |
|---|---|---|
| `local_file.config` | `managed/app-config.json` | Tampered with out-of-band to create drift |
| `local_file.readme` | `managed/README.txt` | Left alone — proves drift is reported per-resource, not blanket |

## Pinned provider

```hcl
local = {
  source  = "hashicorp/local"
  version = "2.5.2"   # exact, not ~>
}
```

The pin is **exact**, not a `~>` range, so an `init` a year from now resolves
the same provider build. `.terraform.lock.hcl` is committed alongside it (this
directory's `.gitignore` deliberately negates the parent
`terraform/.gitignore` rule that would otherwise exclude it) — the version
constraint says *what* to fetch, the lock file says *exactly which bytes*.

## Reproduce

```bash
cd terraform/local
./run-drift-demo.sh
```

Raw output of every step is written to `out/` and committed as the audit
record. The script runs: `version`, `init`, `fmt -check`, `validate`, `plan`,
`apply`, `plan` (clean), tamper, `plan` (drift), `diff`, `apply` (reconcile),
`plan` (clean again).

Verified with **Terraform v1.15.8** on windows_amd64 (the repo's
`.terraform-version` pins 1.6.0; every `required_version` here is `>= 1.6.0`,
which 1.15.8 satisfies).

## Result

| Step | Output |
|---|---|
| `fmt -check` | clean (no output) |
| `validate` | `Success! The configuration is valid.` |
| initial `plan` | `Plan: 2 to add, 0 to change, 0 to destroy.` |
| `apply` | `Resources: 2 added` |
| `plan` after apply | `No changes. Your infrastructure matches the configuration.` |
| `plan` after tampering | drift reported, `Plan: 1 to add, 0 to change, 0 to destroy.` |
| `apply` (reconcile) | `Resources: 1 added` — file content restored |
| final `plan` | `No changes.` |

## Honest caveat: how `local_file` reports drift

Tampering set `replicas: 9, logLevel: debug` on disk. Terraform detected it,
but **not** as an in-place diff. It reported:

```
Note: Objects have changed outside of Terraform

  # local_file.config has been deleted
  - resource "local_file" "config" {
      - content_sha256 = "6f663aac..." -> null
```

…followed by `+ local_file.config will be created` and
`Plan: 1 to add, 0 to change, 0 to destroy.`

Why: the `local` provider's `Read` recomputes the file's `content_sha256` and,
on mismatch, **removes the resource from state entirely** rather than
recording the observed value. So the plan shows the *desired* content and
never surfaces the tampered value (`replicas = 9` appears nowhere in the plan
output).

This differs from a real cloud resource, where the provider reads back actual
attribute values and the plan shows `~ update in-place` with
`replicas: 9 -> 2`. The drift is caught either way and reconcile restores the
declared state — but the *shape* of the report is provider-specific, and this
one loses the "what it drifted to" half of the diff.

The AWS stack in `terraform/` (see `terraform/README.md`) is where
`~ update in-place` diffs actually show observed values.

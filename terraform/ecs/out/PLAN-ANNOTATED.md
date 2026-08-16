# `terraform plan` — ECS topology, annotated

Submission artifact for the brief's Terraform item: *"Run `terraform plan` and include
the annotated output as a submission artifact."*

```
terraform -chdir=terraform/ecs init
terraform -chdir=terraform/ecs plan -out=out/ecs.tfplan
```

**Result: `Plan: 31 to add, 0 to change, 0 to destroy.`**
Raw output: [`plan-raw.txt`](plan-raw.txt) · binary plan: `ecs.tfplan`

## Read this first

This stack is **planned, never applied.** Ship's live deployment is Render
(`terraform/render/`), which carries the destroy-and-redeploy proof. This
configuration exists because the brief names an ECS-shaped topology — *"app
container, database, networking, IAM task role and execution role"* — and Render has
no equivalent of either IAM role. Rather than claim the vocabulary matched or stand up
a second real stack serving no traffic, the topology is described in the vocabulary
asked for and the fact that it is not the deployment is stated here.

It plans **without AWS credentials**: the provider sets `skip_credentials_validation`,
`skip_requesting_account_id` and `skip_metadata_api_check`, and the stack contains no
`data` sources. Anyone with a checkout reproduces this artifact exactly. That
constraint is why networking is declared inline in `network.tf` instead of reusing
`../modules/vpc` — that module opens with `data "aws_availability_zones"`, and the
first plan attempt failed on precisely that call after planning the other 23 resources.

## The 31 resources, by what they do

### The app container (4)

| Resource | Note |
|---|---|
| `aws_ecs_cluster.main` | Container Insights on. |
| `aws_ecs_task_definition.app` | **The app container.** Fargate, `awsvpc`, 512 CPU / 1024 MiB. `DATABASE_URL` arrives as a `secrets` entry, not an `environment` one — so it is resolved by the ECS agent at start and never appears in the task definition, in state, or in the console. |
| `aws_ecs_service.app` | Keeps 2 tasks. Circuit breaker with rollback: a bad deploy stops itself instead of replacing every healthy task. `assign_public_ip = false`. |
| `aws_ecr_repository.app` | `IMMUTABLE` tags — a tag that can move is a rollback you cannot trust. |

Health check hits **`/ready`**, not `/health`: `/ready` asserts the platform tables
exist, so a container that booted against an unmigrated database is reported unhealthy
rather than quietly serving 500s.

### IAM — the two roles, and why they are two (5)

This is the part most worth being able to explain out loud.

| Resource | Who assumes it | Blast radius if widened |
|---|---|---|
| `aws_iam_role.execution` | The **ECS agent**, before the container starts | Image-pull and secret-fetch credentials. The application never assumes this role. |
| `aws_iam_role_policy.execution_secrets` | — | Scoped to this stack's one secret ARN, not `*`. |
| `aws_iam_role_policy_attachment.execution_managed` | — | `AmazonECSTaskExecutionRolePolicy` — the AWS-managed minimum for pull + logs. |
| `aws_iam_role.task` | The **running application** | Everything the app can be tricked into calling. This is the role an SSRF or RCE inherits. |
| `aws_iam_role_policy.task_runtime` | — | `ssm:GetParameter*` under `/ship/prod/*` only, `kms:Decrypt` conditioned on `kms:ViaService = ssm`, and `logs:` on this log group alone. Derived from the calls the code actually makes, not from a convenient managed policy. |

### Database (4)

`aws_db_instance.postgres` (Postgres 16.4, encrypted, 7-day backups),
`aws_db_subnet_group.postgres` (private subnets only), `aws_secretsmanager_secret.db_url`
+ `_version`, and `random_password.db` — the password is generated and never declared in
a variable, a `.tfvars`, or this file.

**`deletion_protection = true` is set on exactly one resource, and it is this one.** The
destroy-and-redeploy exercise proves the *config* is the source of truth; data is the one
thing the config cannot re-derive.

### Networking (16) and security groups (2)

VPC, an internet gateway, 2 public + 2 private subnets across 2 AZs, one NAT gateway with
its EIP, 2 route tables and their 4 associations.

One NAT gateway rather than one per AZ: cheaper, and a single-AZ NAT outage degrades
egress rather than serving. That is a stated tradeoff, not an oversight.

The security groups are where the topology is actually enforced:

- `aws_security_group.app` — **no ingress rule at all.** Nothing reaches a task directly.
- `aws_security_group.database` — Postgres ingress from **the app security group**, not
  from a CIDR block. A CIDR rule would admit anything that later lands in that range;
  a security-group reference admits only these tasks.

## What a reader should challenge

- **`kms:Decrypt` on `Resource = "*"`.** Genuinely broad, and narrowed by the
  `kms:ViaService` condition rather than by ARN, because the SSM-managed key ARN is not
  known at plan time. The tighter form pins the key ARN once it exists.
- **AZs derived from the region string** (`us-east-1` → `us-east-1a`, `us-east-1b`).
  A region with non-contiguous AZ letters needs them spelled out. This is the cost of
  removing the `data` source, and it is the deliberate trade named above.
- **No load balancer or TLS listener.** The service runs in private subnets with no
  ingress; a serving build adds an ALB, its security group, and an ACM certificate. This
  stack describes the topology the brief enumerates, and stops there rather than
  half-building an internet-facing surface it never applies.

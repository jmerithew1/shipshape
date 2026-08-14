# C2 — IAM Least-Privilege (before → after, with per-permission rationale)

**Honest scope note.** The Week-6 platform is deployed on **Render**, which has
no AWS IAM task/execution roles — so on the graded deployment this policy is not
in the live path (secrets come from Render env vars). This is the least-privilege
design for Ship's **AWS deployment mode** (the legacy Elastic Beanstalk path),
and it is derived from what the code *actually* calls, not from a template:

| AWS call the code makes | Where | Permission it needs |
| --- | --- | --- |
| `ssm:GetParameter` with `WithDecryption:true` on `/ship/{env}/*` | `api/src/config/ssm.ts:26` | `ssm:GetParameter` (path-scoped) + `kms:Decrypt` (SecureString) |
| `s3:PutObject` / `s3:DeleteObject` / presigned `GetObject` | `api/src/routes/files.ts:11,418` | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` (object-scoped) |
| `bedrock:InvokeModel` | `api/src/services/ai-analysis.ts:13` | `bedrock:InvokeModel` (model-scoped) |

Placeholders: `${REGION}` (default `us-east-1`), `${ACCOUNT}`, `${ENV}`
(e.g. `staging`), `${UPLOAD_BUCKET}`, `${SSM_KMS_KEY_ID}`, `${BEDROCK_MODEL}`.

---

## BEFORE — the over-permissioned starting point

The role starts on the AWS-managed `AdministratorAccess` policy — every action
on every resource. It "works" precisely because it can do anything, which is the
problem: a compromise of the app process is a compromise of the whole account.

```json
{ "Version": "2012-10-17",
  "Statement": [ { "Effect": "Allow", "Action": "*", "Resource": "*" } ] }
```

---

## AFTER — least privilege (one statement per real need)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadOwnSsmParametersOnly",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/ship/${ENV}/*"
    },
    {
      "Sid": "DecryptSecureStringParametersOnly",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:${REGION}:${ACCOUNT}:key/${SSM_KMS_KEY_ID}",
      "Condition": {
        "StringEquals": { "kms:ViaService": "ssm.${REGION}.amazonaws.com" }
      }
    },
    {
      "Sid": "UploadsBucketObjectsOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${UPLOAD_BUCKET}/*"
    },
    {
      "Sid": "InvokeTheOneModelOnly",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:${REGION}::foundation-model/${BEDROCK_MODEL}"
    }
  ]
}
```

### Per-permission rationale (why each line exists, and why it stops there)
- **`ssm:GetParameter` scoped to `/ship/${ENV}/*`** — the app reads exactly five
  config parameters at boot (`ssm.ts`). Not `GetParameters`/`GetParametersByPath`
  (it fetches by exact name), not `PutParameter` (it never writes), and the path
  prefix means it can't read another app's or another environment's secrets.
- **`kms:Decrypt`, single key, `ViaService: ssm`** — the parameters are
  SecureString (`WithDecryption:true`), so decryption is required, but only
  through SSM and only with the one CMK that encrypts them. No standalone
  decrypt, no other keys.
- **`s3:{Put,Get,Delete}Object` on `${UPLOAD_BUCKET}/*`** — file attachments are
  written, served via presigned GET, and deleted (`files.ts`). Object-level only:
  no `s3:*`, no bucket-level actions (`DeleteBucket`, `PutBucketPolicy`), no other
  bucket.
- **`bedrock:InvokeModel` on one model** — the AI analysis invokes a single
  foundation model (`ai-analysis.ts`). Not `bedrock:*`, not model management, not
  every model in the account.

Everything else — RDS admin, IAM, EC2, CloudFormation, other buckets/params/keys —
is denied by default because it is simply absent.

---

## Verification (the exercise the rubric asks for)

**Allow-works** (the service does its job on the minimal policy):
```bash
# boot reads its five params + decrypts them
aws ssm get-parameter --name /ship/${ENV}/DATABASE_URL --with-decryption   # -> value
# a file upload round-trips
aws s3api put-object --bucket ${UPLOAD_BUCKET} --key smoke/ok.txt --body ok.txt  # -> ETag
# the model answers
aws bedrock-runtime invoke-model --model-id ${BEDROCK_MODEL} --body '{...}' out.json  # -> 200
```

**Deny-fails** (an out-of-policy action is refused — the proof it's actually
least-privilege, not just "works"):
```bash
aws ssm put-parameter --name /ship/${ENV}/EVIL --value x --type String
#   -> AccessDenied: not authorized to perform ssm:PutParameter
aws s3 rb s3://${UPLOAD_BUCKET}
#   -> AccessDenied: not authorized to perform s3:DeleteBucket
aws iam list-users
#   -> AccessDenied: not authorized to perform iam:ListUsers
```

Capture both — a green "allow" and a red "deny" — as the before/after evidence.

---

## Rollout (zero-blast-radius, matches the plan)

1. **Duplicate identity first.** Create a *new* role with the AFTER policy; do
   not touch the identity prod uses yet.
2. **Prove it on the duplicate** — run the allow-works + deny-fails checks above
   with the new role's credentials.
3. **Swap prod to it** only after the checks pass; keep the old credentials valid
   until a smoke test confirms the running service, then revoke.
4. **Rollback** = point back at the old role; nothing was deleted.

This never runs `AdministratorAccess` against a shared prod identity blind — the
minimal policy is proven on a throwaway identity before prod ever sees it.

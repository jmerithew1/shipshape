/**
 * ECS deployment topology — Ship.
 *
 * WHY THIS EXISTS, STATED PLAINLY. The brief's Terraform item asks for "a
 * terraform/ directory with a complete config describing the deployment
 * topology (app container, database, networking, IAM task role and execution
 * role)". Every one of those nouns is ECS vocabulary, and Ship's live
 * deployment is Render, which has no equivalent of a task role or an execution
 * role — Render has no IAM at all.
 *
 * So there were two honest options: describe the real deployment in its own
 * vocabulary and note the gap, or describe the topology the brief names. This
 * file does the second WITHOUT pretending to be the deployment. It is a
 * plan-only stack: it produces the annotated `terraform plan` artifact the
 * brief asks for, and it is never applied. `terraform/render/` remains the
 * source of truth for what actually serves traffic, and carries the
 * destroy-and-redeploy proof.
 *
 * The alternative — standing up a second, real ECS stack serving no traffic
 * purely to match a word list — was considered and rejected. A deployment that
 * exists to be graded rather than used is theater, and it would have to be
 * paid for and secured like the real thing.
 *
 * READING THIS AT THE DEFENSE. The two IAM roles are the part worth
 * understanding, because they are the ones people conflate:
 *
 *   execution role  — used by the ECS AGENT, before the container starts. It
 *                     pulls the image and fetches secrets to inject as env.
 *                     The application never assumes it.
 *   task role       — used by the APPLICATION, at runtime. Every AWS call the
 *                     running code makes is authorised by this role.
 *
 * Blast radius follows from that split: widening the execution role exposes
 * pull-time and secret-fetch credentials; widening the task role exposes
 * whatever the running app can be tricked into calling. They are separated
 * here, with the narrowest policy each one needs, for exactly that reason.
 */

locals {
  name = "${var.project_name}-${var.environment}"

  # Resolved rather than defaulted inline so the ECR repository below is the
  # single source of the image path.
  container_image = coalesce(var.container_image, "${aws_ecr_repository.app.repository_url}:latest")
}

# Networking lives in network.tf — declared inline because the shared VPC
# module needs an AWS API call this stack deliberately cannot make.
# ── App container image ─────────────────────────────────────────────────────
resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE" # a tag that can move is a rollback you cannot trust

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ── Database ────────────────────────────────────────────────────────────────
resource "aws_db_subnet_group" "postgres" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db_url" {
  name = "${local.name}/database-url"
}

resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id = aws_secretsmanager_secret.db_url.id
  secret_string = format(
    "postgresql://%s:%s@%s:5432/%s",
    var.db_username,
    random_password.db.result,
    aws_db_instance.postgres.address,
    var.db_name,
  )
}

resource "aws_db_instance" "postgres" {
  identifier     = "${local.name}-postgres"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [aws_security_group.database.id]

  backup_retention_period   = 7
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-postgres-final"
  deletion_protection       = true

  # The whole point of the destroy-and-redeploy exercise is that the CONFIG is
  # the source of truth. Data is the one thing that cannot be re-derived from
  # it, which is why this is the only resource here with deletion protection.
}

# ── IAM: execution role (the ECS agent, before the container runs) ──────────
resource "aws_iam_role" "execution" {
  name = "${local.name}-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "${local.name}-execution-secrets"
  role = aws_iam_role.execution.id

  # Scoped to THIS stack's secret, not `*`. The execution role can read the
  # database URL to inject it as an environment variable and nothing else.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.db_url.arn]
    }]
  })
}

# ── IAM: task role (the application, at runtime) ────────────────────────────
resource "aws_iam_role" "task" {
  name = "${local.name}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "task_runtime" {
  name = "${local.name}-task-runtime"
  role = aws_iam_role.task.id

  # Deliberately minimal, and it starts from what the code actually calls
  # rather than from a convenient managed policy — the same exercise
  # docs/week6-iam-least-privilege.md performs against the live SSM identity.
  # Ship's runtime AWS surface is: read its own parameters, decrypt them, and
  # write its own logs. It never lists buckets, never assumes another role.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = ["arn:aws:ssm:${var.aws_region}:*:parameter/${var.project_name}/${var.environment}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = ["*"]
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.app.arn}:*"]
      },
    ]
  })
}

# ── Logs ────────────────────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
}

# ── The app container ───────────────────────────────────────────────────────
resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory

  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = local.container_image
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = tostring(var.container_port) },
    ]

    # Injected by the ECS agent using the EXECUTION role, before the app runs —
    # so the connection string never appears in the task definition, in state,
    # or in the console.
    secrets = [{
      name      = "DATABASE_URL"
      valueFrom = aws_secretsmanager_secret.db_url.arn
    }]

    # /ready, not /health: it asserts the platform tables are present, so a
    # container that booted against an unmigrated database is reported
    # unhealthy instead of quietly serving 500s.
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://localhost:${var.container_port}/ready || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  # Roll forward without a gap in capacity, and let a failing deployment stop
  # itself rather than replacing every healthy task with a broken one.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_iam_role_policy.execution_secrets]
}

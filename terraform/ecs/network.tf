/**
 * Networking, declared inline rather than via ../modules/vpc.
 *
 * The shared VPC module opens with `data "aws_availability_zones" "available"`,
 * which is an API call — and an API call is precisely what this stack cannot
 * make, because it plans without credentials so that anyone with a checkout can
 * reproduce the artifact. The first plan attempt failed on exactly that data
 * source, after successfully planning the other 23 resources.
 *
 * AZs are therefore derived from the region name. That is a real tradeoff, not
 * a free win: a region whose AZ letters are not contiguous from `a` would need
 * these spelled out. It is stated here rather than discovered later.
 */

locals {
  azs = [for i in range(var.az_count) : "${var.aws_region}${substr("abcdefgh", i, 1)}"]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-igw" }
}

# Public subnets carry the NAT gateway and, in a full build, the load balancer.
resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public-${local.azs[count.index]}" }
}

# Tasks and the database live here. `assign_public_ip = false` on the service
# is only meaningful because these subnets have no route to the IGW.
resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 100)
  availability_zone = local.azs[count.index]

  tags = { Name = "${local.name}-private-${local.azs[count.index]}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

# One NAT gateway, not one per AZ: cheaper, and a single-AZ NAT outage degrades
# egress rather than serving. Named here because it is the kind of cost/
# resilience tradeoff a plan reader should see stated, not infer.
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]

  tags = { Name = "${local.name}-nat" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ── Security groups ─────────────────────────────────────────────────────────

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "Ship API tasks"
  vpc_id      = aws_vpc.main.id

  # Ingress is intentionally absent: nothing reaches a task directly. A load
  # balancer's security group would be referenced here in a serving build.

  egress {
    description = "Outbound to the database, AWS APIs, and webhook subscribers"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-app" }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "Postgres, reachable only from the app tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from the app security group only — not from a CIDR"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  tags = { Name = "${local.name}-database" }
}

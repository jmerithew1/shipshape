#!/usr/bin/env node
/**
 * Write the generated public spec to docs/openapi.json (submission requirement:
 * "Live at /api/v1/openapi.json on the deployed instance, plus a static copy at
 * docs/openapi.json in the repo").
 *
 * The static copy is a BUILD ARTIFACT, never hand-edited: it is produced from
 * the same in-process generator the server serves, so the committed file and
 * the live endpoint cannot disagree. Re-run whenever routes change.
 *
 *   pnpm --filter @ship/api openapi:v1
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createV1Router } from '../platform/api/v1/router.js';
import { registerV1Routes } from '../platform/api/v1/resources/routes.js';
import { buildV1Spec } from '../platform/openapi/v1-registry.js';

// Routes must be registered before the spec is built — registration is what
// populates the OpenAPI registry.
const app = express();
app.use('/api/v1', createV1Router(registerV1Routes));

const spec = buildV1Spec();
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const outPath = join(repoRoot, 'docs', 'openapi.json');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

const operations = Object.values(spec.paths ?? {}).reduce(
  (n, item) => n + Object.keys(item as Record<string, unknown>).length,
  0
);
console.log(`Wrote ${outPath}`);
console.log(`  OpenAPI ${spec.openapi} · ${Object.keys(spec.paths ?? {}).length} paths · ${operations} operations`);

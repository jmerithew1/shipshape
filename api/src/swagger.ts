/**
 * Swagger/OpenAPI Setup
 *
 * This module configures Swagger UI and serves the OpenAPI specification.
 * Schemas are auto-generated from Zod validators via @asteasolutions/zod-to-openapi.
 */

import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { OpenAPIObject } from 'openapi3-ts/oas30';

// Import the OpenAPI module to register all schemas
import { generateOpenAPIDocument } from './openapi/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Generate the OpenAPI spec from registered schemas
export const swaggerSpec: OpenAPIObject = generateOpenAPIDocument();

export function setupSwagger(app: Express): void {
  // Serve swagger UI at /api/docs
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Ship API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'method',
    },
  }));

  // Serve the PLATFORM (v1) API docs at /api/v1/docs.
  //
  // This is a DIFFERENT surface from /api/docs above. That one documents the
  // internal app API (the routes the SPA calls); this one documents the public
  // /api/v1 platform contract — the OAuth-scoped surface third-party
  // integrations build against. Before this existed the v1 spec was reachable
  // only as raw JSON at /api/v1/openapi.json, so "read the docs" meant reading
  // a JSON blob.
  //
  // Mounted here rather than on the v1 router because per-route token/scope
  // gating lives inside that router's factory; the spec itself is deliberately
  // public (see platform/openapi/serve-spec.ts for that rationale), and the UI
  // that renders it must be public for the same reason.
  //
  // `setup(null, { swaggerOptions.url })` rather than passing the spec object:
  // the v1 spec is built lazily on first request, after every route module has
  // registered. Handing the UI a URL keeps that laziness intact — the browser
  // fetches the freshly-built spec instead of us snapshotting it at boot.
  app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(null, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Ship Platform API v1',
    swaggerOptions: {
      url: '/api/v1/openapi.json',
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'method',
    },
  }));

  // Serve the raw OpenAPI spec
  app.get('/api/openapi.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  app.get('/api/openapi.yaml', (req, res) => {
    res.setHeader('Content-Type', 'text/yaml');
    const yaml = jsonToYaml(swaggerSpec);
    res.send(yaml);
  });
}

// Simple JSON to YAML converter (no external dependency needed)
function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);

  if (obj === null) return 'null';
  if (obj === undefined) return '';
  if (typeof obj === 'string') {
    if (obj.includes('\n') || obj.includes(':') || obj.includes('#')) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      const value = jsonToYaml(item, indent + 1);
      if (typeof item === 'object' && item !== null) {
        return `${spaces}- ${value.trim().replace(/^/, '').replace(/\n/g, `\n${spaces}  `)}`;
      }
      return `${spaces}- ${value}`;
    }).join('\n');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';
    return entries.map(([key, value]) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return `${spaces}${key}:\n${jsonToYaml(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        return `${spaces}${key}:\n${jsonToYaml(value, indent + 1)}`;
      } else {
        return `${spaces}${key}: ${jsonToYaml(value, indent)}`;
      }
    }).join('\n');
  }

  return String(obj);
}

// Generate static openapi.yaml file
export function generateOpenApiFile(): void {
  const yaml = jsonToYaml(swaggerSpec);
  const outputPath = path.join(__dirname, '..', 'openapi.yaml');
  fs.writeFileSync(outputPath, yaml, 'utf-8');
  console.log(`OpenAPI spec written to ${outputPath}`);

  // Also generate JSON version
  const jsonPath = path.join(__dirname, '..', 'openapi.json');
  fs.writeFileSync(jsonPath, JSON.stringify(swaggerSpec, null, 2), 'utf-8');
  console.log(`OpenAPI spec written to ${jsonPath}`);
}

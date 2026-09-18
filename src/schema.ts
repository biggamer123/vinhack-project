/**
 * Blast Radius - lightweight database schema discovery for SQL and NoSQL code.
 *
 * This is intentionally static and conservative: it looks for common schema
 * declarations in JavaScript/TypeScript/Go and SQL files, and surfaces them in a
 * single view so the user can inspect tables/collections without parsing a full
 * database engine.
 */

import * as vscode from "vscode";

export type SchemaKind = "sql" | "nosql";

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface SchemaRelation {
  from: string;
  to: string;
  label: string;
}

export interface DatabaseSchema {
  kind: SchemaKind;
  name: string;
  source: string;
  fields: SchemaField[];
}

const EXCLUDE = "**/{node_modules,dist,build,out,.git,coverage,.next,vendor}/**";
const SOURCE_GLOB = "**/*.{js,jsx,mjs,cjs,ts,mts,cts,tsx,go,sql,prisma}";

function normalizeName(value: string): string {
  return value.replace(/^['"`]+|['"`]+$/g, "").trim();
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const next = value[i + 1];

    if (quote) {
      current += ch;
      if (ch === quote && value[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }

    if (ch === delimiter && depth === 0) {
      parts.push(current.trim());
      current = "";
      if (next === " ") {
        i++;
      }
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) {
    parts.push(tail);
  }

  return parts.filter(Boolean);
}

function recordSchema(
  list: DatabaseSchema[],
  kind: SchemaKind,
  name: string,
  source: string,
  fields: SchemaField[],
): void {
  const normalized = normalizeName(name);
  if (!normalized) {
    return;
  }

  const found = list.find(
    (entry) => entry.kind === kind && entry.name === normalized && entry.source === source,
  );
  if (found) {
    found.fields = [...found.fields, ...fields];
    return;
  }

  list.push({ kind, name: normalized, source, fields });
}

function parseSqlCreateTables(text: string, file: string): DatabaseSchema[] {
  const schemas: DatabaseSchema[] = [];
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`|"|')?([A-Za-z0-9_\.]+)(?:`|"|')?\s*\(([\s\S]*?)\)\s*(?:;|$)/gi;

  for (const match of text.matchAll(tableRe)) {
    const name = match[1];
    const body = match[2];
    const fields: SchemaField[] = [];

    for (const raw of splitTopLevel(body, ",")) {
      const line = raw.trim();
      if (!line || /^CONSTRAINT\b|^PRIMARY\s+KEY\b|^FOREIGN\s+KEY\b|^UNIQUE\b|^CHECK\b/i.test(line)) {
        continue;
      }

      const entry = line.match(
        /^(?:`|"|')?([A-Za-z_][A-Za-z0-9_]*)?(?:`|"|')?\s+([A-Za-z0-9_]+(?:\([^)]*\))?)(.*)$/i,
      );
      if (!entry) {
        continue;
      }

      const fieldName = entry[1] || entry[0].split(/\s+/)[0];
      const type = entry[2].trim();
      const tail = (entry[3] || "").trim();
      const isPrimaryKey = /PRIMARY\s+KEY/i.test(tail) || /PRIMARY\s+KEY/i.test(line);
      const nullable = !/NOT\s+NULL/i.test(tail) && !isPrimaryKey;
      fields.push({
        name: normalizeName(fieldName),
        type,
        nullable,
        primaryKey: isPrimaryKey,
      });
    }

    recordSchema(schemas, "sql", name, file, fields);
  }

  return schemas;
}

function parseNoSqlSchemaBody(body: string, source: string, kind: SchemaKind): SchemaField[] {
  const fields: SchemaField[] = [];
  const chunks = splitTopLevel(body, ",");

  for (const line of chunks) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }

    const helperField = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*,?$/i);
    if (helperField) {
      const [, fieldName, helperName, helperArgs = ""] = helperField;
      const normalizedHelper = helperName.toLowerCase();
      const type = /requiredstringfield|indexedstringfield|enumstringfield/.test(normalizedHelper)
        ? "String"
        : /booleanfield/.test(normalizedHelper)
          ? "Boolean"
          : /numberfield/.test(normalizedHelper)
            ? "Number"
            : /datefield/.test(normalizedHelper)
              ? "Date"
              : "mixed";
      const required = /true|1/.test(helperArgs) || /required\s*:\s*true/i.test(helperArgs);
      fields.push({
        name: fieldName,
        type,
        nullable: !required,
        primaryKey: /_id|id\b/i.test(fieldName) && /ObjectId|String/i.test(type),
      });
      continue;
    }

    const directCallField = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^)]*)\)\s*,?$/i);
    if (directCallField) {
      const [, fieldName, helperName] = directCallField;
      const normalizedHelper = helperName.toLowerCase();
      const type = /requiredstringfield|indexedstringfield|enumstringfield/.test(normalizedHelper)
        ? "String"
        : /booleanfield/.test(normalizedHelper)
          ? "Boolean"
          : /numberfield/.test(normalizedHelper)
            ? "Number"
            : /datefield/.test(normalizedHelper)
              ? "Date"
              : "mixed";
      fields.push({
        name: fieldName,
        type,
        nullable: !/required\s*:\s*true|true|1/i.test(trimmed),
        primaryKey: /_id|id\b/i.test(fieldName) && /ObjectId|String/i.test(type),
      });
      continue;
    }

    const fieldPattern = /^(?:['"`])?([A-Za-z_][A-Za-z0-9_]*)(?:['"`])?\s*:\s*(\{[\s\S]*\}|[A-Za-z0-9_.]+(?:\[[^\]]*\])?|[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\))\s*,?$/i;
    const objectField = trimmed.match(fieldPattern);

    if (objectField) {
      const fieldName = objectField[1];
      const fieldValue = objectField[2].trim();
      let fieldType = "mixed";

      if (fieldValue.startsWith("{")) {
        const embeddedType = fieldValue.match(/type\s*:\s*([A-Za-z0-9_.]+|\[[^\]]+\])/i)?.[1] || "object";
        fieldType = embeddedType.replace(/^\[|\]$/g, "");
      } else {
        fieldType = fieldValue.replace(/\s*\[[^\]]*\]$/, "");
      }

      const rest = trimmed.replace(objectField[0], "");
      const nullable = !/required\s*:\s*true|required\s*:\s*1/i.test(rest);
      fields.push({
        name: fieldName,
        type: fieldType,
        nullable,
        primaryKey: /_id|id\b/i.test(fieldName) && /ObjectId|String/i.test(fieldType),
      });
      continue;
    }

    const prismaField = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_]+(?:\[[^\]]+\])?)(\s+@\w+.*)?$/i);
    if (prismaField && kind === "nosql") {
      const [, name, type] = prismaField;
      fields.push({
        name,
        type,
        nullable: !/\?\s*$/.test(type) && !/\b@id\b/i.test(trimmed),
        primaryKey: /@id/i.test(trimmed),
      });
    }
  }

  return fields;
}

function parseNoSqlSchemas(text: string, file: string): DatabaseSchema[] {
  const schemas: DatabaseSchema[] = [];

  const mongooseSchemaRe = /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+(?:mongoose\.)?Schema(?:<[^>]+>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/gi;
  const modelRe = /(?:mongoose\.)?model\s*\(\s*(?:['"`])([^'"`]+)(?:['"`])\s*,\s*([A-Za-z_][A-Za-z0-9_]*|\{[\s\S]*?\})\s*\)/gi;
  const prismaModelRe = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}\s*(?:\n|$)/gi;

  for (const match of text.matchAll(mongooseSchemaRe)) {
    const name = match[1];
    const body = match[2];
    recordSchema(schemas, "nosql", name, file, parseNoSqlSchemaBody(body, file, "nosql"));
  }

  for (const match of text.matchAll(modelRe)) {
    const name = match[1];
    const body = match[2];
    const normalized = typeof body === "string" ? body.trim() : body;
    const fields = normalized.startsWith("{")
      ? parseNoSqlSchemaBody(normalized.slice(1, -1), file, "nosql")
      : [];
    recordSchema(schemas, "nosql", name, file, fields);
  }

  for (const match of text.matchAll(prismaModelRe)) {
    const name = match[1];
    const body = match[2];
    const fields: SchemaField[] = [];
    for (const raw of body.split(/\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("//")) {
        continue;
      }
      const parsed = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_]+(?:\[[^\]]+\])?)(\s+.*)?$/i);
      if (!parsed) {
        continue;
      }
      const [, fieldName, type, tail = ""] = parsed;
      fields.push({
        name: fieldName,
        type,
        nullable: !/\?/i.test(type) && !/@id/i.test(tail),
        primaryKey: /@id/i.test(tail),
      });
    }
    recordSchema(schemas, "nosql", name, file, fields);
  }

  return schemas;
}

export function extractDatabaseSchemas(file: string, text: string): DatabaseSchema[] {
  const combined: DatabaseSchema[] = [];
  combined.push(...parseSqlCreateTables(text, file));
  combined.push(...parseNoSqlSchemas(text, file));

  return combined.filter((schema) => schema.fields.length > 0 || /collection\(|Schema\(|model\(/i.test(text));
}

export function inferSchemaRelations(schemas: DatabaseSchema[]): SchemaRelation[] {
  const byName = new Map<string, DatabaseSchema>();
  for (const schema of schemas) {
    byName.set(schema.name.toLowerCase(), schema);
  }

  const relations: SchemaRelation[] = [];
  const seen = new Set<string>();

  for (const schema of schemas) {
    for (const field of schema.fields) {
      const candidate = field.name.toLowerCase();
      const direct = candidate.replace(/(?:_id|id)$/, "");
      const target = byName.get(direct) || byName.get(direct + "s");
      if (!target || target.name === schema.name) {
        continue;
      }
      const key = `${schema.name}->${target.name}:${field.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      relations.push({
        from: schema.name,
        to: target.name,
        label: field.name,
      });
    }
  }

  return relations;
}

export function schemaDiagramHtml(schemas: DatabaseSchema[]): string {
  if (schemas.length === 0) {
    return `<!doctype html><html><body style="font-family:system-ui;padding:32px;background:#111;color:#eee"><h1>Database Schemas</h1><p>No SQL or NoSQL schema declarations were detected in this workspace.</p></body></html>`;
  }

  const relations = inferSchemaRelations(schemas);
  const entityWidth = 220;
  const entityHeight = 40 + Math.min(10, 10) * 22;
  const entities = schemas.map((schema, index) => {
    const computedHeight = 40 + Math.min(schema.fields.length, 10) * 22;
    const column = index % 2;
    const row = Math.floor(index / 2);
    return {
      ...schema,
      x: 40 + column * 420,
      y: 60 + row * (computedHeight + 80),
      width: entityWidth,
      height: computedHeight,
    };
  });
  const byName = new Map(entities.map((entity) => [entity.name, entity]));

  const links = relations
    .map((relation) => {
      const from = byName.get(relation.from);
      const to = byName.get(relation.to);
      if (!from || !to) {
        return "";
      }
      const x1 = from.x + from.width;
      const y1 = from.y + 24 + Math.min(18, from.fields.length * 4);
      const x2 = to.x;
      const y2 = to.y + 24 + Math.min(18, to.fields.length * 4);
      const cx1 = x1 + 60;
      const cx2 = x2 - 60;
      return `
        <path d="M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}" stroke="#f6d365" stroke-width="2" fill="none" marker-end="url(#arrow)" />
        <text x="${(x1 + x2) / 2}" y="${Math.min(y1, y2) - 6}" fill="#f8f8f8" font-size="10">${relation.label}</text>
      `;
    })
    .join("");

  const entityMarkup = entities
    .map((entity) => {
      const rows = entity.fields
        .map(
          (field) => `
            <tr>
              <td>${field.name}</td>
              <td>${field.type}</td>
              <td>${field.nullable ? "yes" : "no"}</td>
              <td>${field.primaryKey ? "PK" : ""}</td>
            </tr>
          `,
        )
        .join("");
      return `
        <div class="entity" style="left:${entity.x}px;top:${entity.y}px;width:${entity.width}px;">
          <div class="entity-kind">${entity.kind === "sql" ? "SQL" : "NoSQL"}</div>
          <div class="entity-name">${entity.name}</div>
          <div class="entity-source">${entity.source}</div>
          <table>
            <thead><tr><th>Field</th><th>Type</th><th>Null</th><th>PK</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    })
    .join("");

  return `<!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          body {
            margin: 0;
            font-family: system-ui, sans-serif;
            background: #111827;
            color: #edf2ff;
          }
          .wrap {
            position: relative;
            min-height: 100vh;
            background: linear-gradient(180deg, #111827 0%, #1f2937 100%);
            padding: 24px;
          }
          h1 {
            margin: 0 0 18px;
            font-size: 24px;
          }
          .diagram {
            position: relative;
            min-height: 760px;
          }
          .entity {
            position: absolute;
            background: rgba(17, 24, 39, 0.92);
            border: 2px solid #f6d365;
            border-radius: 12px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.35);
            overflow: hidden;
          }
          .entity-kind {
            background: #f6d365;
            color: #111827;
            font-weight: 700;
            padding: 6px 10px;
            font-size: 12px;
          }
          .entity-name {
            padding: 8px 10px 2px;
            font-size: 17px;
            font-weight: 700;
          }
          .entity-source {
            color: #cbd5e1;
            padding: 0 10px 8px;
            font-size: 11px;
            word-break: break-word;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
          }
          th, td {
            border-top: 1px solid rgba(255,255,255,0.12);
            padding: 6px 8px;
            text-align: left;
            vertical-align: top;
          }
          thead {
            background: rgba(255,255,255,0.05);
          }
          svg {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>Database Schema Diagram</h1>
          <div class="diagram">
            <svg viewBox="0 0 1200 1000" preserveAspectRatio="xMidYMin meet" aria-label="ER diagram">
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="#f6d365"></path>
                </marker>
              </defs>
              ${links}
            </svg>
            ${entityMarkup}
          </div>
        </div>
      </body>
    </html>`;
}

export async function detectDatabaseSchemas(root: string): Promise<DatabaseSchema[]> {
  const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE, 1000);
  const results: DatabaseSchema[] = [];

  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      for (const schema of extractDatabaseSchemas(uri.fsPath, text)) {
        results.push(schema);
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return results;
}

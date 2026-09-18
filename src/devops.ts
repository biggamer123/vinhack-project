/**
 * Blast Radius - DevOps view: read a project's Docker setup as structure.
 *
 * Finds every Dockerfile and compose file, parses them, links compose services
 * to the Dockerfiles they build and guesses each service's technology. The view
 * draws that structure and shows the files' own lines; nothing here rewrites a
 * file into prose. The only text produced is short check labels (no volume on a
 * database, no readiness wait, password in compose, unpinned tools) and the
 * docker commands for each service.
 *
 * Dependency-free apart from the `yaml` parser, with no vscode import, so
 * scripts/check-devops.js can run it against real repositories.
 */
import * as fs from "fs";
import * as path from "path";
import { parseAllDocuments } from "yaml";

/* ------------------------------------------------------------------ types */

export type Level = "info" | "warn" | "risk";

export interface Finding {
  level: Level;
  title: string;
  detail: string;
  service?: string;
  file?: string;
  line?: number;
}

export interface Tech {
  id: string;
  label: string;
  kind: "frontend" | "backend" | "database" | "cache" | "queue" | "proxy" | "tool" | "runtime";
}

export interface DockerInstruction {
  op: string;
  args: string;
  line: number;
}

export interface DockerfileInfo {
  path: string;
  dir: string;
  stages: { name: string | null; image: string; line: number }[];
  finalImage: string;
  multiStage: boolean;
  exposes: string[];
  cmd: string | null;
  entrypoint: string | null;
  workdir: string | null;
  user: string | null;
  healthcheck: boolean;
  envKeys: string[];
  instructions: DockerInstruction[];
  /** The file as written, for showing the real lines. */
  text: string;
  tech: Tech | null;
  purpose: "development" | "production" | "unknown";
  /** What made it look like a dev or production image, e.g. "air" or "multi-stage". */
  purposeHint: string;
  hasDockerignore: boolean;
  findings: Finding[];
}

export interface PortMapping {
  host: string | null;
  container: string;
  protocol: string;
  raw: string;
}

export interface VolumeMount {
  kind: "named" | "bind" | "anonymous";
  source: string | null;
  target: string;
  readOnly: boolean;
  raw: string;
}

export interface EnvVar {
  key: string;
  /** Masked when it looks like a secret. */
  value: string | null;
  secretLike: boolean;
  fromVariable: boolean;
}

export interface ComposeService {
  name: string;
  image: string | null;
  build: { context: string; dockerfile: string; dockerfilePath: string | null } | null;
  dockerfile: DockerfileInfo | null;
  ports: PortMapping[];
  environment: EnvVar[];
  envFiles: string[];
  volumes: VolumeMount[];
  dependsOn: { name: string; condition: string | null }[];
  networks: string[];
  command: string | null;
  healthcheck: boolean;
  restart: string | null;
  tech: Tech | null;
  role: Tech["kind"] | "service";
  findings: Finding[];
  commands: { label: string; command: string }[];
  line: number;
  /** This service's block from the compose file, as written. */
  block: string;
}

export interface ComposeFile {
  path: string;
  services: ComposeService[];
  namedVolumes: string[];
  networks: string[];
  text: string;
  error?: string;
}

export interface DevopsPayload {
  root: string;
  composeFiles: ComposeFile[];
  dockerfiles: DockerfileInfo[];
  /** Dockerfiles no compose service builds. */
  standaloneDockerfiles: DockerfileInfo[];
  /** Folders with an app in them but no Dockerfile and no compose service. */
  looseApps: { path: string; tech: Tech }[];
  findings: Finding[];
  counts: { composeFiles: number; services: number; built: number; images: number; dockerfiles: number; standalone: number; looseApps: number };
  commands: { label: string; command: string; warn?: string }[];
  filesScanned: number;
}

/* ------------------------------------------------------------- discovery */

const SKIP = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out", "coverage", "vendor",
  "target", ".venv", "venv", "__pycache__", ".turbo", "tmp", ".blastradius",
]);

const isDockerfile = (name: string) => name === "Dockerfile" || /^Dockerfile\./i.test(name) || /\.dockerfile$/i.test(name);
const isCompose = (name: string) => /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(name);

function walk(root: string, maxDepth = 6): { dockerfiles: string[]; composes: string[]; dirs: string[]; count: number } {
  const out = { dockerfiles: [] as string[], composes: [] as string[], dirs: [root], count: 0 };
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth || out.count > 20000) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) {
          const full = path.join(dir, e.name);
          if (depth < 2) {
            out.dirs.push(full);
          }
          visit(full, depth + 1);
        }
        continue;
      }
      out.count++;
      if (isDockerfile(e.name)) {
        out.dockerfiles.push(path.join(dir, e.name));
      } else if (isCompose(e.name)) {
        out.composes.push(path.join(dir, e.name));
      }
    }
  };
  visit(root, 0);
  return out;
}

/* ------------------------------------------------------------------ tech */

const IMAGE_TECH: [RegExp, Tech][] = [
  [/(^|\/)(postgres|postgis)(:|$)/i, { id: "postgres", label: "PostgreSQL", kind: "database" }],
  [/(^|\/)(mysql|mariadb)(:|$)/i, { id: "mysql", label: "MySQL", kind: "database" }],
  [/(^|\/)mongo(db)?(:|$)/i, { id: "mongo", label: "MongoDB", kind: "database" }],
  [/(^|\/)(redis|valkey|keydb)(:|$)/i, { id: "redis", label: "Redis", kind: "cache" }],
  [/(^|\/)rabbitmq(:|$)/i, { id: "rabbitmq", label: "RabbitMQ", kind: "queue" }],
  [/(^|\/)(kafka|cp-kafka|redpanda)(:|$)/i, { id: "kafka", label: "Kafka", kind: "queue" }],
  [/(^|\/)(nginx|traefik|caddy|haproxy)(:|$)/i, { id: "nginx", label: "Reverse proxy", kind: "proxy" }],
  [/(^|\/)(adminer|pgadmin4?|phpmyadmin|mailhog|mailpit|minio)(:|$)/i, { id: "tool", label: "Tool", kind: "tool" }],
  [/(^|\/)golang(:|$)/i, { id: "go", label: "Go", kind: "backend" }],
  [/(^|\/)node(:|$)/i, { id: "node", label: "Node.js", kind: "runtime" }],
  [/(^|\/)python(:|$)/i, { id: "python", label: "Python", kind: "backend" }],
  [/(^|\/)(eclipse-temurin|openjdk|amazoncorretto|maven|gradle)(:|$)/i, { id: "java", label: "Java", kind: "backend" }],
  [/(^|\/)rust(:|$)/i, { id: "rust", label: "Rust", kind: "backend" }],
  [/(^|\/)php(:|$)/i, { id: "php", label: "PHP", kind: "backend" }],
  [/(^|\/)(dotnet\/)?(sdk|aspnet)(:|$)/i, { id: "dotnet", label: ".NET", kind: "backend" }],
];

export function techFromImage(image: string | null | undefined): Tech | null {
  if (!image) {
    return null;
  }
  for (const [re, tech] of IMAGE_TECH) {
    if (re.test(image)) {
      return tech;
    }
  }
  return null;
}

/** What kind of app lives in a folder, from its manifest files. */
export function techFromFolder(dir: string): Tech | null {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      return "";
    }
  };
  if (has("package.json")) {
    const pkg = read("package.json");
    if (/"next"\s*:/.test(pkg)) return { id: "nextjs", label: "Next.js", kind: "frontend" };
    if (/"@nestjs\/core"\s*:/.test(pkg)) return { id: "nestjs", label: "NestJS", kind: "backend" };
    if (/"vue"\s*:/.test(pkg)) return { id: "vue", label: "Vue", kind: "frontend" };
    if (/"react"\s*:/.test(pkg)) return { id: "react", label: "React", kind: "frontend" };
    if (/"express"\s*:|"fastify"\s*:|"koa"\s*:/.test(pkg)) return { id: "express", label: "Node.js API", kind: "backend" };
    return { id: "node", label: "Node.js", kind: "backend" };
  }
  if (has("go.mod")) return { id: "go", label: "Go", kind: "backend" };
  if (has("Cargo.toml")) return { id: "rust", label: "Rust", kind: "backend" };
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) return { id: "java", label: "Java", kind: "backend" };
  const py = read("requirements.txt") + read("pyproject.toml");
  if (py || has("manage.py")) {
    if (/django/i.test(py) || has("manage.py")) return { id: "django", label: "Django", kind: "backend" };
    if (/fastapi/i.test(py)) return { id: "fastapi", label: "FastAPI", kind: "backend" };
    if (/flask/i.test(py)) return { id: "flask", label: "Flask", kind: "backend" };
    return { id: "python", label: "Python", kind: "backend" };
  }
  return null;
}

/* ------------------------------------------------------------ dockerfile */

export function parseDockerfileText(text: string): DockerInstruction[] {
  const out: DockerInstruction[] = [];
  const lines = text.split(/\r?\n/);
  let buffer = "";
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!buffer && (trimmed === "" || trimmed.startsWith("#"))) {
      continue;
    }
    if (!buffer) {
      startLine = i;
    }
    if (trimmed.startsWith("#")) {
      continue; // comment inside a continued instruction
    }
    if (/\\\s*$/.test(raw)) {
      buffer += raw.replace(/\\\s*$/, "") + " ";
      continue;
    }
    buffer += raw;
    const match = /^\s*([A-Za-z]+)\s*(.*)$/.exec(buffer);
    if (match) {
      out.push({ op: match[1].toUpperCase(), args: match[2].trim().replace(/\s+/g, " "), line: startLine });
    }
    buffer = "";
  }
  if (buffer.trim()) {
    const match = /^\s*([A-Za-z]+)\s*(.*)$/.exec(buffer);
    if (match) {
      out.push({ op: match[1].toUpperCase(), args: match[2].trim(), line: startLine });
    }
  }
  return out;
}

function execForm(args: string): string {
  const trimmed = args.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.join(" ");
      }
    } catch {
      // not valid JSON - show as written
    }
  }
  return trimmed;
}

const DEV_SERVER = /\b(air\b|nodemon|next dev|npm run dev|yarn dev|pnpm dev|vite(?!\s+build)\b|uvicorn .*--reload|flask run|rails s|ng serve|cargo watch|watchexec|reflex)\b/i;

export function analyzeDockerfile(root: string, file: string): DockerfileInfo {
  const text = fs.readFileSync(file, "utf8");
  const instructions = parseDockerfileText(text);
  const rel = path.relative(root, file) || path.basename(file);
  const dir = path.dirname(file);
  const findings: Finding[] = [];
  const stages: DockerfileInfo["stages"] = [];
  const exposes: string[] = [];
  const envKeys: string[] = [];
  let cmd: string | null = null;
  let entrypoint: string | null = null;
  let workdir: string | null = null;
  let user: string | null = null;
  let healthcheck = false;

  for (const ins of instructions) {
    switch (ins.op) {
      case "FROM": {
        const m = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(ins.args);
        if (m) stages.push({ image: m[1], name: m[2] || null, line: ins.line });
        break;
      }
      case "EXPOSE":
        exposes.push(...ins.args.split(/\s+/).filter(Boolean));
        break;
      case "CMD":
        cmd = execForm(ins.args);
        break;
      case "ENTRYPOINT":
        entrypoint = execForm(ins.args);
        break;
      case "WORKDIR":
        workdir = ins.args;
        break;
      case "USER":
        user = ins.args;
        break;
      case "HEALTHCHECK":
        healthcheck = !/^NONE$/i.test(ins.args);
        break;
      case "ENV": {
        const pairs = ins.args.includes("=")
          ? [...ins.args.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1])
          : [ins.args.split(/\s+/)[0]];
        envKeys.push(...pairs);
        break;
      }
    }
  }

  const finalImage = stages.length ? stages[stages.length - 1].image : "unknown";
  const runs = instructions.filter((i) => i.op === "RUN").map((i) => i.args);
  const startCommand = [entrypoint, cmd].filter(Boolean).join(" ");
  const tech = techFromImage(stages.length ? stages[0].image : null) || techFromFolder(dir);
  const refineTech = techFromFolder(dir);
  const effectiveTech = refineTech && tech && (tech.kind === "runtime" || tech.id === refineTech.id || tech.id === "node") ? refineTech : tech || refineTech;

  let purpose: DockerfileInfo["purpose"] = "unknown";
  let purposeHint = "";
  if (DEV_SERVER.test(startCommand) || runs.some((r) => /\bair-verse\/air\b|\bnodemon\b/.test(r))) {
    purpose = "development";
    purposeHint = ((DEV_SERVER.exec(startCommand) || [""])[0] || "file watcher").trim();
  } else if (stages.length > 1 || user) {
    purpose = "production";
    purposeHint = stages.length > 1 ? "multi-stage" : "non-root user";
  }

  const hasDockerignore = fs.existsSync(path.join(dir, ".dockerignore"));
  if (!hasDockerignore) {
    findings.push({
      level: "warn",
      title: "No .dockerignore",
      detail: rel,
      file: rel,
    });
  }

  for (const ins of instructions) {
    if (ins.op === "RUN" && /@latest\b/.test(ins.args)) {
      findings.push({
        level: "warn",
        title: "Tool pinned to @latest",
        detail: ins.args.slice(0, 90),
        file: rel,
        line: ins.line,
      });
    }
  }
  for (const stage of stages) {
    const image = stage.image;
    if (!/[:@]/.test(image.replace(/^[^/]*:\d+\//, "")) && !/^\$|^scratch$/i.test(image) && !stages.some((s) => s.name === image)) {
      findings.push({ level: "warn", title: "Base image untagged", detail: image, file: rel, line: stage.line });
    } else if (/:latest$/i.test(image)) {
      findings.push({ level: "warn", title: "Base image :latest", detail: image, file: rel, line: stage.line });
    }
  }

  // COPY . . before installing dependencies throws away the dependency cache on every code change.
  const firstBigCopy = instructions.findIndex((i) => i.op === "COPY" && /^(--\S+\s+)*\.\s+\S+/.test(i.args));
  const installAfter = instructions.findIndex((i, idx) => idx > firstBigCopy && i.op === "RUN" && /\b(npm (ci|install)|yarn install|pnpm install|go mod download|pip install|bundle install|mvn .*dependency)/.test(i.args));
  if (firstBigCopy !== -1 && installAfter !== -1) {
    findings.push({
      level: "warn",
      title: "COPY . . before install",
      detail: "dependency cache busted on every change",
      file: rel,
      line: instructions[firstBigCopy].line,
    });
  }

  if (!user && purpose !== "development") {
    findings.push({ level: "info", title: "No USER (runs as root)", detail: rel, file: rel });
  }

  return {
    path: rel,
    dir: path.relative(root, dir) || ".",
    stages,
    finalImage,
    multiStage: stages.length > 1,
    exposes,
    cmd,
    entrypoint,
    workdir,
    user,
    healthcheck,
    envKeys,
    instructions,
    text: text.length > 20000 ? text.slice(0, 20000) : text,
    tech: effectiveTech,
    purpose,
    purposeHint,
    hasDockerignore,
    findings,
  };
}

/* --------------------------------------------------------------- compose */

const SECRET_KEY = /(PASS(WORD)?|SECRET|TOKEN|PRIVATE|API_?KEY|ACCESS_?KEY|CREDENTIAL)/i;

function asString(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function parsePorts(value: unknown): PortMapping[] {
  if (!Array.isArray(value)) return [];
  return value.map((p): PortMapping => {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      return { host: o.published !== undefined ? asString(o.published) : null, container: asString(o.target), protocol: asString(o.protocol) || "tcp", raw: JSON.stringify(o) };
    }
    const raw = asString(p);
    const [spec, protocol] = raw.split("/");
    const parts = spec.split(":");
    const container = parts[parts.length - 1];
    const host = parts.length >= 2 ? parts[parts.length - 2] : null;
    return { host, container, protocol: protocol || "tcp", raw };
  });
}

function parseVolumes(value: unknown): VolumeMount[] {
  if (!Array.isArray(value)) return [];
  return value.map((v): VolumeMount => {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const type = asString(o.type);
      const kind: VolumeMount["kind"] = type === "bind" ? "bind" : o.source ? "named" : "anonymous";
      return { kind, source: o.source ? asString(o.source) : null, target: asString(o.target), readOnly: !!o.read_only, raw: JSON.stringify(o) };
    }
    const raw = asString(v);
    const parts = raw.split(":");
    if (parts.length === 1) {
      return { kind: "anonymous", source: null, target: parts[0], readOnly: false, raw };
    }
    const source = parts[0];
    const target = parts[1];
    const readOnly = parts[2] === "ro";
    const bind = /^[./~]/.test(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("${");
    return { kind: bind ? "bind" : "named", source, target, readOnly, raw };
  });
}

function parseEnv(value: unknown): EnvVar[] {
  const entries: [string, string | null][] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = asString(item);
      const eq = text.indexOf("=");
      entries.push(eq === -1 ? [text, null] : [text.slice(0, eq), text.slice(eq + 1)]);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      entries.push([k, v === null ? null : asString(v)]);
    }
  }
  return entries.map(([key, raw]) => {
    const fromVariable = raw !== null && /\$\{?[A-Za-z_]/.test(raw);
    const secretLike = SECRET_KEY.test(key) || (raw !== null && /:\/\/[^:/\s]+:[^@\s]+@/.test(raw));
    let value = raw;
    if (raw !== null && secretLike && !fromVariable) {
      // Show the shape of a URL but never the password in it.
      value = /:\/\/[^:/\s]+:[^@\s]+@/.test(raw) ? raw.replace(/(:\/\/[^:/\s]+:)[^@\s]+@/, "$1****@") : "****";
    }
    return { key, value, secretLike, fromVariable };
  });
}

function parseDependsOn(value: unknown): { name: string; condition: string | null }[] {
  if (Array.isArray(value)) return value.map((v) => ({ name: asString(v), condition: null }));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([name, o]) => ({
      name,
      condition: o && typeof o === "object" ? asString((o as Record<string, unknown>).condition) || null : null,
    }));
  }
  return [];
}

/** A service's lines from the compose file, from its key to the next sibling key. */
function blockOf(text: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const start = lineOf(text, key);
  const indent = (lines[start] || "").match(/^\s*/)?.[0].length ?? 2;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const lead = l.match(/^\s*/)?.[0].length ?? 0;
    if (l.trim() && lead <= indent) break;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

function lineOf(text: string, key: string): number {
  // [ \t] rather than \s: \s also matches newlines, which let the match start on a blank line above.
  const m = new RegExp(`^[ \\t]{2,}${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:`, "m").exec(text);
  return m ? text.slice(0, m.index).split("\n").length - 1 : 0;
}

export function analyzeCompose(root: string, file: string, dockerfiles: Map<string, DockerfileInfo>): ComposeFile {
  const rel = path.relative(root, file) || path.basename(file);
  const text = fs.readFileSync(file, "utf8");
  let doc: Record<string, unknown> | null = null;
  try {
    const docs = parseAllDocuments(text);
    if (docs.length && docs[0].errors.length) {
      return { path: rel, services: [], namedVolumes: [], networks: [], text, error: docs[0].errors[0].message };
    }
    doc = (docs[0]?.toJS() as Record<string, unknown>) || null;
  } catch (err) {
    return { path: rel, services: [], namedVolumes: [], networks: [], text, error: String(err) };
  }
  const servicesRaw = (doc && typeof doc.services === "object" && doc.services) || {};
  const baseDir = path.dirname(file);
  const services: ComposeService[] = [];

  for (const [name, rawService] of Object.entries(servicesRaw as Record<string, unknown>)) {
    const s = (rawService || {}) as Record<string, unknown>;
    let build: ComposeService["build"] = null;
    let dockerfile: DockerfileInfo | null = null;
    if (s.build !== undefined) {
      const b = typeof s.build === "string" ? { context: s.build } : (s.build as Record<string, unknown>);
      const context = asString(b.context) || ".";
      const dockerfileName = asString(b.dockerfile) || "Dockerfile";
      const abs = path.resolve(baseDir, context, dockerfileName);
      dockerfile = dockerfiles.get(abs) || null;
      build = { context, dockerfile: dockerfileName, dockerfilePath: fs.existsSync(abs) ? path.relative(root, abs) : null };
    }
    const image = s.image ? asString(s.image) : null;
    const buildDir = build ? path.resolve(baseDir, build.context) : null;
    const tech = (dockerfile && dockerfile.tech) || techFromImage(image) || (buildDir ? techFromFolder(buildDir) : null);
    const networks = Array.isArray(s.networks) ? s.networks.map(asString) : s.networks && typeof s.networks === "object" ? Object.keys(s.networks as object) : [];

    services.push({
      name,
      image,
      build,
      dockerfile,
      ports: parsePorts(s.ports),
      environment: parseEnv(s.environment),
      envFiles: Array.isArray(s.env_file) ? s.env_file.map(asString) : s.env_file ? [asString(s.env_file)] : [],
      volumes: parseVolumes(s.volumes),
      dependsOn: parseDependsOn(s.depends_on),
      networks,
      command: s.command ? (Array.isArray(s.command) ? s.command.join(" ") : asString(s.command)) : null,
      healthcheck: !!s.healthcheck,
      restart: s.restart ? asString(s.restart) : null,
      tech,
      role: tech ? (tech.kind === "runtime" ? "backend" : tech.kind) : "service",
      findings: [],
      commands: [],
      line: lineOf(text, name),
      block: blockOf(text, name),
    });
  }

  const namedVolumes = doc && doc.volumes && typeof doc.volumes === "object" ? Object.keys(doc.volumes as object) : [];
  const networkNames = doc && doc.networks && typeof doc.networks === "object" ? Object.keys(doc.networks as object) : [];
  const byName = new Map(services.map((s) => [s.name, s]));
  for (const service of services) {
    checkService(service, byName, rel, namedVolumes);
  }
  return { path: rel, services, namedVolumes, networks: networkNames, text };
}

/** Checks and handy commands for one service. Structure only - no prose about the file. */
function checkService(s: ComposeService, byName: Map<string, ComposeService>, file: string, namedVolumes: string[]): void {
  const f = s.findings;
  const at = { service: s.name, file, line: s.line };

  if (s.build && !s.build.dockerfilePath) {
    f.push({ level: "risk", title: "Dockerfile missing", detail: `No ${s.build.dockerfile} in ${s.build.context}`, ...at });
  }
  if (!s.build && s.image && (!/:/.test(s.image.replace(/^[^/]*:\d+\//, "")) || /:latest$/.test(s.image))) {
    f.push({ level: "warn", title: "Image not pinned", detail: `${s.image} follows latest`, ...at });
  }
  if ((s.role === "database" || s.role === "cache") && s.ports.some((p) => p.host)) {
    f.push({ level: "info", title: "Port open on host", detail: `localhost:${s.ports.find((p) => p.host)!.host}`, ...at });
  }
  if (s.dockerfile && s.ports.length) {
    const published = new Set(s.ports.map((p) => p.container.split("-")[0]));
    for (const exposed of s.dockerfile.exposes) {
      const port = exposed.split("/")[0];
      if (!published.has(port)) {
        f.push({ level: "warn", title: "EXPOSE not published", detail: `EXPOSE ${port}, ports: ${[...published].join(", ")}`, ...at });
      }
    }
  }
  for (const env of s.environment) {
    const raw = env.value || "";
    if (/localhost|127\.0\.0\.1/.test(raw) && !/^(NEXT_PUBLIC_|VITE_|REACT_APP_)/.test(env.key)) {
      f.push({ level: "warn", title: "localhost in a container", detail: `${env.key}=${raw}`, ...at });
    }
    if (env.secretLike && !env.fromVariable && env.value !== null) {
      f.push({ level: "warn", title: "Password in compose", detail: env.key, ...at });
    }
  }
  for (const v of s.volumes) {
    if (v.kind === "named" && v.source && !namedVolumes.includes(v.source)) {
      f.push({ level: "risk", title: "Undeclared volume", detail: v.source, ...at });
    }
  }
  if ((s.role === "database" || s.tech?.id === "rabbitmq") && !s.volumes.some((v) => v.kind !== "anonymous")) {
    f.push({ level: "risk", title: "No volume - data lost on recreate", detail: s.name, ...at });
  }
  for (const dep of s.dependsOn) {
    if (!byName.has(dep.name)) {
      f.push({ level: "risk", title: "Depends on missing service", detail: dep.name, ...at });
    }
  }
  const waitsOnData = s.dependsOn.filter((d) => {
    const other = byName.get(d.name);
    return !d.condition && other && (other.role === "database" || other.role === "cache" || other.role === "queue");
  });
  if (waitsOnData.length) {
    f.push({ level: "warn", title: "No readiness wait", detail: `depends_on ${waitsOnData.map((d) => d.name).join(", ")} without condition: service_healthy`, ...at });
  }
  if (s.dockerfile) {
    for (const df of s.dockerfile.findings) {
      f.push({ ...df, service: s.name });
    }
  }

  const cmds = s.commands;
  cmds.push({ label: "up", command: `docker compose up -d ${s.name}` });
  if (s.build) cmds.push({ label: "rebuild", command: `docker compose up -d --build ${s.name}` });
  cmds.push({ label: "logs", command: `docker compose logs -f ${s.name}` });
  cmds.push({ label: "shell", command: `docker compose exec ${s.name} sh` });
  if (s.tech?.id === "postgres") {
    const user = s.environment.find((e) => e.key === "POSTGRES_USER");
    const db = s.environment.find((e) => e.key === "POSTGRES_DB");
    cmds.push({ label: "psql", command: `docker compose exec ${s.name} psql -U ${user && user.value && user.value !== "****" ? user.value : "postgres"}${db && db.value ? ` -d ${db.value}` : ""}` });
  } else if (s.tech?.id === "mysql") {
    cmds.push({ label: "mysql", command: `docker compose exec ${s.name} mysql -u root -p` });
  } else if (s.tech?.id === "redis") {
    cmds.push({ label: "redis-cli", command: `docker compose exec ${s.name} redis-cli` });
  } else if (s.tech?.id === "mongo") {
    cmds.push({ label: "mongosh", command: `docker compose exec ${s.name} mongosh` });
  }
}

/* ------------------------------------------------------------------ entry */

export function analyzeProject(root: string): DevopsPayload {
  const found = walk(root);
  const dockerfiles = new Map<string, DockerfileInfo>();
  for (const file of found.dockerfiles) {
    try {
      dockerfiles.set(path.resolve(file), analyzeDockerfile(root, file));
    } catch {
      // unreadable - skip
    }
  }
  const composeFiles = found.composes
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
    .map((file) => analyzeCompose(root, file, dockerfiles));

  const used = new Set<string>();
  for (const c of composeFiles) {
    for (const s of c.services) {
      if (s.dockerfile) used.add(s.dockerfile.path);
    }
  }
  const all = [...dockerfiles.values()];
  const standalone = all.filter((d) => !used.has(d.path));

  const containerised = new Set<string>([
    ...all.map((d) => path.resolve(root, d.dir)),
    ...composeFiles.flatMap((c) => c.services.filter((s) => s.build).map((s) => path.resolve(root, path.dirname(c.path), s.build!.context))),
  ]);
  const looseApps: DevopsPayload["looseApps"] = [];
  for (const dir of found.dirs) {
    const tech = techFromFolder(dir);
    if (tech && !containerised.has(path.resolve(dir))) {
      looseApps.push({ path: path.relative(root, dir) || ".", tech });
    }
  }

  const findings: Finding[] = [];
  for (const c of composeFiles) {
    if (c.error) findings.push({ level: "risk", title: "Compose parse error", detail: c.error, file: c.path });
  }
  if (composeFiles.length === 0 && all.length > 1) {
    findings.push({ level: "info", title: "No compose file", detail: `${all.length} Dockerfiles` });
  }
  for (const loose of looseApps) {
    findings.push({ level: "info", title: "Not containerised", detail: `${loose.path} (${loose.tech.label})` });
  }

  const services = composeFiles.flatMap((c) => c.services);
  const counts = {
    composeFiles: composeFiles.length,
    services: services.length,
    built: services.filter((sv) => sv.build).length,
    images: services.filter((sv) => !sv.build).length,
    dockerfiles: all.length,
    standalone: standalone.length,
    looseApps: looseApps.length,
  };

  const commands: DevopsPayload["commands"] = [];
  if (composeFiles.length) {
    const flag = composeFiles[0].path === "docker-compose.yml" || composeFiles[0].path === "compose.yaml" || composeFiles[0].path === "compose.yml" || composeFiles[0].path === "docker-compose.yaml" ? "" : ` -f ${composeFiles[0].path}`;
    commands.push(
      { label: "up --build", command: `docker compose${flag} up --build` },
      { label: "up -d", command: `docker compose${flag} up -d` },
      { label: "ps", command: `docker compose${flag} ps` },
      { label: "logs", command: `docker compose${flag} logs -f` },
      { label: "down", command: `docker compose${flag} down` },
      { label: "down -v", command: `docker compose${flag} down -v`, warn: "deletes named volume data" },
    );
  }
  for (const d of standalone) {
    const tag = (path.basename(d.dir === "." ? root : d.dir) || "app").toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const port = d.exposes[0] ? d.exposes[0].split("/")[0] : null;
    commands.push({ label: `build ${d.path}`, command: `docker build -t ${tag} -f ${d.path} ${d.dir}` });
    commands.push({ label: `run ${tag}`, command: `docker run --rm ${port ? `-p ${port}:${port} ` : ""}${tag}` });
  }

  const allFindings = [
    ...findings,
    ...composeFiles.flatMap((c) => c.services.flatMap((s) => s.findings)),
    ...standalone.flatMap((d) => d.findings),
  ];
  return {
    root,
    composeFiles,
    dockerfiles: all,
    standaloneDockerfiles: standalone,
    looseApps,
    findings: allFindings,
    counts,
    commands,
    filesScanned: found.count,
  };
}

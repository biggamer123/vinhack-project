/**
 * Blast Radius - Docker project builder.
 *
 * Turns a stack picked in the DEVOPS tab (say Go + Next.js + PostgreSQL) into a
 * docker-compose.yml, one Dockerfile and .dockerignore per app, an .env.example
 * and a short command guide. Two modes: development (hot reload, code mounted
 * into the containers) and production (multi-stage builds, non-root users).
 *
 * No imports and no Node APIs on purpose: the same compiled code is injected
 * into the webview so the files update live while services are dragged in, and
 * scripts/check-devops.js validates the output with `docker compose config`.
 *
 * Image tags and tool versions were checked against Docker Hub and the Go
 * module proxy when written; bump them here when new releases land.
 */

export type ServiceKind = "frontend" | "backend" | "database" | "cache" | "queue" | "proxy" | "tool";

export interface OptionDef {
  key: string;
  label: string;
  type: "select" | "text" | "toggle";
  choices?: string[];
  default: string | boolean;
}

export interface TemplateDef {
  id: string;
  label: string;
  kind: ServiceKind;
  /** Short badge text drawn on the luggage. */
  badge: string;
  color: string;
  defaultName: string;
  defaultFolder?: string;
  port: number;
  devPort?: number;
  options: OptionDef[];
  /** One-line hint shown in the palette. */
  hint: string;
}

export interface StackService {
  id: string;
  template: string;
  name: string;
  folder: string;
  hostPort: number;
  options: Record<string, string | boolean>;
}

export interface Stack {
  projectName: string;
  mode: "development" | "production";
  services: StackService[];
}

export interface GeneratedFile {
  path: string;
  language: "dockerfile" | "yaml" | "ini" | "nginx" | "markdown" | "text";
  content: string;
  /** Which service the file belongs to, if any. */
  service?: string;
}

export interface GuideStep {
  title: string;
  commands: string[];
  note?: string;
}

export interface GeneratedStack {
  files: GeneratedFile[];
  guide: GuideStep[];
  warnings: string[];
  urls: { service: string; url: string }[];
}

/* --------------------------------------------------------------- catalog */

const NODE_VERSIONS = ["22", "20"];
const PM = ["npm", "pnpm", "yarn"];

export const CATALOG: TemplateDef[] = [
  { id: "nextjs", label: "Next.js", kind: "frontend", badge: "NEXT", color: "#17140f", defaultName: "web", defaultFolder: "frontend", port: 3000,
    hint: "React framework with server rendering",
    options: [
      { key: "node", label: "Node version", type: "select", choices: NODE_VERSIONS, default: "22" },
      { key: "pm", label: "Package manager", type: "select", choices: PM, default: "npm" },
    ] },
  { id: "react-vite", label: "React (Vite)", kind: "frontend", badge: "REACT", color: "#3B4CCA", defaultName: "web", defaultFolder: "frontend", port: 80, devPort: 5173,
    hint: "Single-page app, served by nginx in production",
    options: [
      { key: "node", label: "Node version", type: "select", choices: NODE_VERSIONS, default: "22" },
      { key: "pm", label: "Package manager", type: "select", choices: PM, default: "npm" },
    ] },
  { id: "vue-vite", label: "Vue (Vite)", kind: "frontend", badge: "VUE", color: "#78C850", defaultName: "web", defaultFolder: "frontend", port: 80, devPort: 5173,
    hint: "Single-page app, served by nginx in production",
    options: [
      { key: "node", label: "Node version", type: "select", choices: NODE_VERSIONS, default: "22" },
      { key: "pm", label: "Package manager", type: "select", choices: PM, default: "npm" },
    ] },
  { id: "go", label: "Go", kind: "backend", badge: "GO", color: "#00ADD8", defaultName: "api", defaultFolder: "backend", port: 8080,
    hint: "Compiled API, tiny distroless image in production",
    options: [
      { key: "go", label: "Go version", type: "select", choices: ["1.23", "1.22"], default: "1.23" },
      { key: "entry", label: "Main package", type: "text", default: "." },
    ] },
  { id: "express", label: "Node.js (Express)", kind: "backend", badge: "NODE", color: "#6b9b37", defaultName: "api", defaultFolder: "backend", port: 3000,
    hint: "JavaScript API",
    options: [
      { key: "node", label: "Node version", type: "select", choices: NODE_VERSIONS, default: "22" },
      { key: "pm", label: "Package manager", type: "select", choices: PM, default: "npm" },
      { key: "entry", label: "Entry file", type: "text", default: "server.js" },
    ] },
  { id: "nestjs", label: "NestJS", kind: "backend", badge: "NEST", color: "#DC0A2D", defaultName: "api", defaultFolder: "backend", port: 3000,
    hint: "TypeScript API framework",
    options: [
      { key: "node", label: "Node version", type: "select", choices: NODE_VERSIONS, default: "22" },
      { key: "pm", label: "Package manager", type: "select", choices: PM, default: "npm" },
    ] },
  { id: "fastapi", label: "Python (FastAPI)", kind: "backend", badge: "FAST", color: "#009485", defaultName: "api", defaultFolder: "backend", port: 8000,
    hint: "Python API served by uvicorn",
    options: [
      { key: "python", label: "Python version", type: "select", choices: ["3.12", "3.11"], default: "3.12" },
      { key: "app", label: "App (module:object)", type: "text", default: "main:app" },
    ] },
  { id: "django", label: "Python (Django)", kind: "backend", badge: "DJANGO", color: "#0C4B33", defaultName: "api", defaultFolder: "backend", port: 8000,
    hint: "Python web framework served by gunicorn",
    options: [
      { key: "python", label: "Python version", type: "select", choices: ["3.12", "3.11"], default: "3.12" },
      { key: "project", label: "Django project module", type: "text", default: "config" },
    ] },
  { id: "springboot", label: "Java (Spring Boot)", kind: "backend", badge: "JAVA", color: "#6DB33F", defaultName: "api", defaultFolder: "backend", port: 8080,
    hint: "Maven build, JRE-only runtime image",
    options: [{ key: "java", label: "Java version", type: "select", choices: ["21", "17"], default: "21" }] },
  { id: "rust", label: "Rust (Axum)", kind: "backend", badge: "RUST", color: "#B7410E", defaultName: "api", defaultFolder: "backend", port: 8080,
    hint: "Compiled API on a slim Debian runtime",
    options: [{ key: "bin", label: "Binary name (from Cargo.toml)", type: "text", default: "app" }] },
  { id: "postgres", label: "PostgreSQL", kind: "database", badge: "PG", color: "#336791", defaultName: "db", port: 5432,
    hint: "Relational database",
    options: [
      { key: "version", label: "Version", type: "select", choices: ["16", "15"], default: "16" },
      { key: "database", label: "Database name", type: "text", default: "app" },
      { key: "publish", label: "Open on localhost (for GUI tools)", type: "toggle", default: true },
    ] },
  { id: "mysql", label: "MySQL", kind: "database", badge: "MYSQL", color: "#00758F", defaultName: "db", port: 3306,
    hint: "Relational database",
    options: [
      { key: "version", label: "Version", type: "select", choices: ["8.4", "8.0"], default: "8.4" },
      { key: "database", label: "Database name", type: "text", default: "app" },
      { key: "publish", label: "Open on localhost (for GUI tools)", type: "toggle", default: true },
    ] },
  { id: "mongo", label: "MongoDB", kind: "database", badge: "MONGO", color: "#47A248", defaultName: "mongo", port: 27017,
    hint: "Document database",
    options: [
      { key: "version", label: "Version", type: "select", choices: ["7", "6"], default: "7" },
      { key: "publish", label: "Open on localhost (for GUI tools)", type: "toggle", default: true },
    ] },
  { id: "redis", label: "Redis", kind: "cache", badge: "REDIS", color: "#D82C20", defaultName: "redis", port: 6379,
    hint: "Cache and queues",
    options: [
      { key: "version", label: "Version", type: "select", choices: ["7"], default: "7" },
      { key: "persist", label: "Keep data between restarts", type: "toggle", default: false },
    ] },
  { id: "rabbitmq", label: "RabbitMQ", kind: "queue", badge: "RABBIT", color: "#FF6600", defaultName: "rabbitmq", port: 5672,
    hint: "Message broker with a web dashboard on :15672", options: [] },
  { id: "nginx", label: "Nginx reverse proxy", kind: "proxy", badge: "NGINX", color: "#009639", defaultName: "proxy", port: 80,
    hint: "One URL: / goes to the frontend, /api to the backend", options: [] },
  { id: "adminer", label: "Adminer (DB browser)", kind: "tool", badge: "ADMIN", color: "#6b6355", defaultName: "adminer", port: 8080,
    hint: "Browse your SQL database in the browser", options: [] },
];

export function templateById(id: string): TemplateDef | undefined {
  return CATALOG.find((t) => t.id === id);
}

/* --------------------------------------------------------------- helpers */

function opt(s: StackService, key: string): string | boolean {
  const def = templateById(s.template)?.options.find((o) => o.key === key);
  const v = s.options[key];
  return v === undefined || v === "" ? (def ? def.default : "") : v;
}

function str(s: StackService, key: string): string {
  return String(opt(s, key));
}

function containerPort(s: StackService, mode: Stack["mode"]): number {
  const t = templateById(s.template)!;
  return mode === "development" && t.devPort ? t.devPort : t.port;
}

function lines(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p) => p !== false && p !== null && p !== undefined).join("\n") + "\n";
}

function installCmd(pm: string, production: boolean): { copy: string; run: string; setup?: string } {
  if (pm === "pnpm") {
    return {
      setup: "RUN corepack enable",
      copy: "COPY package.json pnpm-lock.yaml ./",
      run: `RUN pnpm install --frozen-lockfile${production ? " --prod" : ""}`,
    };
  }
  if (pm === "yarn") {
    return {
      setup: "RUN corepack enable",
      copy: "COPY package.json yarn.lock ./",
      run: `RUN yarn install --frozen-lockfile${production ? " --production" : ""}`,
    };
  }
  return { copy: "COPY package.json package-lock.json ./", run: `RUN npm ci${production ? " --omit=dev" : ""}` };
}

function runScript(pm: string, script: string, extra = ""): string {
  const base = pm === "npm" ? ["npm", "run", script] : [pm, script];
  const args = extra ? [...base, ...(pm === "npm" ? ["--"] : []), ...extra.split(" ")] : base;
  return `CMD [${args.map((a) => JSON.stringify(a)).join(", ")}]`;
}

/* ------------------------------------------------------------ dockerfiles */

function dockerfileFor(s: StackService, mode: Stack["mode"]): { content: string; extra: GeneratedFile[] } {
  const dev = mode === "development";
  const port = containerPort(s, mode);
  const extra: GeneratedFile[] = [];
  switch (s.template) {
    case "nextjs": {
      const node = str(s, "node");
      const pm = str(s, "pm");
      const i = installCmd(pm, false);
      if (dev) {
        return { extra, content: lines(
          `# Next.js development image: dependencies are baked in, your code is mounted by compose.`,
          `FROM node:${node}-alpine`,
          `WORKDIR /app`,
          i.setup,
          i.copy,
          i.run,
          `COPY . .`,
          `EXPOSE ${port}`,
          runScript(pm, "dev", `-H 0.0.0.0 -p ${port}`),
        ) };
      }
      return { extra, content: lines(
        `# Next.js production image. Needs output: "standalone" in next.config.(js|ts).`,
        `FROM node:${node}-alpine AS deps`,
        `WORKDIR /app`,
        i.setup,
        i.copy,
        i.run,
        ``,
        `FROM node:${node}-alpine AS build`,
        `WORKDIR /app`,
        i.setup,
        `COPY --from=deps /app/node_modules ./node_modules`,
        `COPY . .`,
        pm === "npm" ? `RUN npm run build` : `RUN ${pm} build`,
        ``,
        `FROM node:${node}-alpine AS run`,
        `WORKDIR /app`,
        `ENV NODE_ENV=production PORT=${port} HOSTNAME=0.0.0.0`,
        `COPY --from=build --chown=node:node /app/public ./public`,
        `COPY --from=build --chown=node:node /app/.next/standalone ./`,
        `COPY --from=build --chown=node:node /app/.next/static ./.next/static`,
        `USER node`,
        `EXPOSE ${port}`,
        `CMD ["node", "server.js"]`,
      ) };
    }
    case "react-vite":
    case "vue-vite": {
      const node = str(s, "node");
      const pm = str(s, "pm");
      const i = installCmd(pm, false);
      if (dev) {
        return { extra, content: lines(
          `# Vite development image: your code is mounted by compose, the dev server reloads on change.`,
          `FROM node:${node}-alpine`,
          `WORKDIR /app`,
          i.setup,
          i.copy,
          i.run,
          `COPY . .`,
          `EXPOSE ${port}`,
          runScript(pm, "dev", `--host 0.0.0.0 --port ${port}`),
        ) };
      }
      extra.push({
        path: `${s.folder}/nginx.conf`,
        language: "nginx",
        service: s.name,
        content: lines(
          `# Serves the built single-page app; unknown paths fall back to index.html so client-side routes work.`,
          `server {`,
          `  listen 80;`,
          `  root /usr/share/nginx/html;`,
          `  index index.html;`,
          `  location / {`,
          `    try_files $uri $uri/ /index.html;`,
          `  }`,
          `}`,
        ),
      });
      return { extra, content: lines(
        `# Build the app with Node, then serve the static files with nginx.`,
        `FROM node:${node}-alpine AS build`,
        `WORKDIR /app`,
        i.setup,
        i.copy,
        i.run,
        `COPY . .`,
        pm === "npm" ? `RUN npm run build` : `RUN ${pm} build`,
        ``,
        `FROM nginx:1.27-alpine`,
        `COPY nginx.conf /etc/nginx/conf.d/default.conf`,
        `COPY --from=build /app/dist /usr/share/nginx/html`,
        `EXPOSE 80`,
      ) };
    }
    case "go": {
      const go = str(s, "go");
      const entry = str(s, "entry") || ".";
      if (dev) {
        return { extra, content: lines(
          `# Go development image with air: rebuilds and restarts the server when a .go file changes.`,
          `FROM golang:${go}-alpine`,
          `WORKDIR /app`,
          `RUN go install github.com/air-verse/air@v1.67.4`,
          `COPY go.mod go.sum* ./`,
          `RUN go mod download`,
          `COPY . .`,
          `EXPOSE ${port}`,
          entry === "."
            ? `CMD ["air"]`
            : `CMD ["air", "--build.cmd", "go build -o ./tmp/main ${entry}", "--build.bin", "./tmp/main"]`,
        ) };
      }
      return { extra, content: lines(
        `# Compile a static Go binary, then run it on a distroless image with no shell and a non-root user.`,
        `FROM golang:${go}-alpine AS build`,
        `WORKDIR /src`,
        `COPY go.mod go.sum* ./`,
        `RUN go mod download`,
        `COPY . .`,
        `RUN CGO_ENABLED=0 GOOS=linux go build -o /out/app ${entry}`,
        ``,
        `FROM gcr.io/distroless/static-debian12:nonroot`,
        `COPY --from=build /out/app /app`,
        `USER nonroot:nonroot`,
        `EXPOSE ${port}`,
        `ENTRYPOINT ["/app"]`,
      ) };
    }
    case "express": {
      const node = str(s, "node");
      const pm = str(s, "pm");
      const entry = str(s, "entry") || "server.js";
      const i = installCmd(pm, !dev);
      return { extra, content: lines(
        dev ? `# Node development image: node --watch restarts the server when a file changes.` : `# Node production image: production dependencies only, runs as the unprivileged node user.`,
        `FROM node:${node}-alpine`,
        `WORKDIR /app`,
        !dev && `ENV NODE_ENV=production`,
        i.setup,
        i.copy,
        i.run,
        dev ? `COPY . .` : `COPY --chown=node:node . .`,
        !dev && `USER node`,
        `EXPOSE ${port}`,
        dev ? `CMD ["node", "--watch", ${JSON.stringify(entry)}]` : `CMD ["node", ${JSON.stringify(entry)}]`,
      ) };
    }
    case "nestjs": {
      const node = str(s, "node");
      const pm = str(s, "pm");
      if (dev) {
        const i = installCmd(pm, false);
        return { extra, content: lines(
          `# NestJS development image: start:dev watches and recompiles on change.`,
          `FROM node:${node}-alpine`,
          `WORKDIR /app`,
          i.setup,
          i.copy,
          i.run,
          `COPY . .`,
          `EXPOSE ${port}`,
          runScript(pm, "start:dev"),
        ) };
      }
      const all = installCmd(pm, false);
      const prod = installCmd(pm, true);
      return { extra, content: lines(
        `# Compile TypeScript in a build stage, ship only dist/ and production dependencies.`,
        `FROM node:${node}-alpine AS build`,
        `WORKDIR /app`,
        all.setup,
        all.copy,
        all.run,
        `COPY . .`,
        pm === "npm" ? `RUN npm run build` : `RUN ${pm} build`,
        ``,
        `FROM node:${node}-alpine`,
        `WORKDIR /app`,
        `ENV NODE_ENV=production`,
        prod.setup,
        prod.copy,
        prod.run,
        `COPY --from=build --chown=node:node /app/dist ./dist`,
        `USER node`,
        `EXPOSE ${port}`,
        `CMD ["node", "dist/main.js"]`,
      ) };
    }
    case "fastapi": {
      const py = str(s, "python");
      const app = str(s, "app") || "main:app";
      return { extra, content: lines(
        dev ? `# FastAPI development image: uvicorn --reload restarts on change.` : `# FastAPI production image, running as an unprivileged user.`,
        `FROM python:${py}-slim`,
        `ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1`,
        `WORKDIR /app`,
        `COPY requirements.txt .`,
        `RUN pip install --no-cache-dir -r requirements.txt`,
        `COPY . .`,
        !dev && `RUN useradd --create-home appuser`,
        !dev && `USER appuser`,
        `EXPOSE ${port}`,
        dev
          ? `CMD ["uvicorn", ${JSON.stringify(app)}, "--host", "0.0.0.0", "--port", "${port}", "--reload"]`
          : `CMD ["uvicorn", ${JSON.stringify(app)}, "--host", "0.0.0.0", "--port", "${port}"]`,
      ) };
    }
    case "django": {
      const py = str(s, "python");
      const project = str(s, "project") || "config";
      return { extra, content: lines(
        dev ? `# Django development image: runserver reloads on change.` : `# Django production image served by gunicorn (add gunicorn to requirements.txt).`,
        `FROM python:${py}-slim`,
        `ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1`,
        `WORKDIR /app`,
        `COPY requirements.txt .`,
        `RUN pip install --no-cache-dir -r requirements.txt`,
        `COPY . .`,
        !dev && `RUN useradd --create-home appuser`,
        !dev && `USER appuser`,
        `EXPOSE ${port}`,
        dev
          ? `CMD ["python", "manage.py", "runserver", "0.0.0.0:${port}"]`
          : `CMD ["gunicorn", "${project}.wsgi:application", "--bind", "0.0.0.0:${port}"]`,
      ) };
    }
    case "springboot": {
      const java = str(s, "java");
      if (dev) {
        return { extra, content: lines(
          `# Spring Boot development image: runs straight from source with Maven.`,
          `FROM maven:3.9-eclipse-temurin-${java}`,
          `WORKDIR /app`,
          `COPY pom.xml .`,
          `RUN mvn -q dependency:go-offline`,
          `COPY src ./src`,
          `EXPOSE ${port}`,
          `CMD ["mvn", "spring-boot:run"]`,
        ) };
      }
      return { extra, content: lines(
        `# Build the jar with Maven, run it on a JRE-only image as a non-root user.`,
        `FROM maven:3.9-eclipse-temurin-${java} AS build`,
        `WORKDIR /src`,
        `COPY pom.xml .`,
        `RUN mvn -q dependency:go-offline`,
        `COPY src ./src`,
        `RUN mvn -q package -DskipTests`,
        ``,
        `FROM eclipse-temurin:${java}-jre-alpine`,
        `WORKDIR /app`,
        `RUN addgroup -S app && adduser -S app -G app`,
        `COPY --from=build /src/target/*.jar app.jar`,
        `USER app`,
        `EXPOSE ${port}`,
        `ENTRYPOINT ["java", "-jar", "/app/app.jar"]`,
      ) };
    }
    case "rust": {
      const bin = str(s, "bin") || "app";
      if (dev) {
        return { extra, content: lines(
          `# Rust development image: cargo run builds and starts the app (rebuild with docker compose restart).`,
          `FROM rust:1.82-slim`,
          `WORKDIR /app`,
          `COPY . .`,
          `EXPOSE ${port}`,
          `CMD ["cargo", "run"]`,
        ) };
      }
      return { extra, content: lines(
        `# Compile in release mode, copy just the binary onto a slim Debian image.`,
        `FROM rust:1.82-slim AS build`,
        `WORKDIR /src`,
        `COPY . .`,
        `RUN cargo build --release`,
        ``,
        `FROM debian:bookworm-slim`,
        `COPY --from=build /src/target/release/${bin} /usr/local/bin/app`,
        `USER 65534:65534`,
        `EXPOSE ${port}`,
        `CMD ["app"]`,
      ) };
    }
    default:
      return { extra, content: "" };
  }
}

function dockerignoreFor(s: StackService): string {
  const common = [".git", ".gitignore", ".env", ".env.*", "Dockerfile", ".dockerignore", "*.md"];
  const byTech: Record<string, string[]> = {
    nextjs: ["node_modules", ".next", "npm-debug.log*"],
    "react-vite": ["node_modules", "dist", "npm-debug.log*"],
    "vue-vite": ["node_modules", "dist", "npm-debug.log*"],
    express: ["node_modules", "npm-debug.log*"],
    nestjs: ["node_modules", "dist", "npm-debug.log*"],
    go: ["tmp", "bin", "*.test"],
    fastapi: ["__pycache__", "*.pyc", ".venv", "venv", ".pytest_cache"],
    django: ["__pycache__", "*.pyc", ".venv", "venv", "staticfiles"],
    springboot: ["target", ".mvn/wrapper/maven-wrapper.jar"],
    rust: ["target"],
  };
  return lines("# Keep these out of the image and out of the build context.", ...(byTech[s.template] || []), ...common);
}

/* ---------------------------------------------------------------- compose */

interface DataService {
  s: StackService;
  envForApps: [string, string][];
}

function dataServiceEnv(s: StackService): [string, string][] {
  switch (s.template) {
    case "postgres":
      return [["DATABASE_URL", `postgres://\${POSTGRES_USER:-app}:\${POSTGRES_PASSWORD:-app}@${s.name}:5432/\${POSTGRES_DB:-${str(s, "database") || "app"}}?sslmode=disable`]];
    case "mysql":
      return [["DATABASE_URL", `mysql://\${MYSQL_USER:-app}:\${MYSQL_PASSWORD:-app}@${s.name}:3306/\${MYSQL_DATABASE:-${str(s, "database") || "app"}}`]];
    case "mongo":
      return [["MONGODB_URI", `mongodb://\${MONGO_USER:-app}:\${MONGO_PASSWORD:-app}@${s.name}:27017`]];
    case "redis":
      return [["REDIS_URL", `redis://${s.name}:6379`]];
    case "rabbitmq":
      return [["AMQP_URL", `amqp://\${RABBITMQ_USER:-app}:\${RABBITMQ_PASSWORD:-app}@${s.name}:5672`]];
    default:
      return [];
  }
}

function yamlScalar(value: string | number): string {
  const text = String(value);
  return /^[\w./:@-]+$/.test(text) && !/^(true|false|yes|no|null|~|\d+(\.\d+)?)$/i.test(text) ? text : JSON.stringify(text);
}

export function generateStack(stack: Stack): GeneratedStack {
  const dev = stack.mode === "development";
  const warnings: string[] = [];
  const files: GeneratedFile[] = [];
  const urls: GeneratedStack["urls"] = [];

  const services = stack.services.filter((s) => templateById(s.template));
  const names = new Set<string>();
  for (const s of services) {
    if (names.has(s.name)) {
      warnings.push(`Two services are both named "${s.name}" - compose needs unique names.`);
    }
    names.add(s.name);
  }
  // Every port published on the host must be unique, or the second service fails to start.
  const hostPorts = new Map<number, string>();
  for (const s of services) {
    for (const port of publishedHostPorts(s)) {
      if (hostPorts.has(port)) {
        warnings.push(`${s.name} and ${hostPorts.get(port)} both use localhost:${port}.`);
      }
      hostPorts.set(port, s.name);
    }
  }
  const folders = new Map<string, string>();
  for (const s of services.filter((x) => ["frontend", "backend"].includes(templateById(x.template)!.kind))) {
    if (folders.has(s.folder)) {
      warnings.push(`${s.name} and ${folders.get(s.folder)} both build from ./${s.folder} - give each app its own folder.`);
    }
    folders.set(s.folder, s.name);
  }

  const apps = services.filter((s) => ["frontend", "backend"].includes(templateById(s.template)!.kind));
  const backends = services.filter((s) => templateById(s.template)!.kind === "backend");
  const frontends = services.filter((s) => templateById(s.template)!.kind === "frontend");
  const data: DataService[] = services
    .filter((s) => ["database", "cache", "queue"].includes(templateById(s.template)!.kind))
    .map((s) => ({ s, envForApps: dataServiceEnv(s) }));
  const sqlDbs = services.filter((s) => s.template === "postgres" || s.template === "mysql");
  const proxy = services.find((s) => s.template === "nginx");

  const out: string[] = [];
  out.push(`# ${stack.projectName || "app"} - generated by Blast Radius (${stack.mode} setup).`);
  out.push(`# Start everything:  docker compose up --build`);
  out.push(`services:`);
  const volumes: string[] = [];
  const envExample: string[] = [];

  for (const s of services) {
    const t = templateById(s.template)!;
    const port = containerPort(s, stack.mode);
    out.push(`  ${s.name}:`);

    if (t.kind === "frontend" || t.kind === "backend") {
      const df = dockerfileFor(s, stack.mode);
      files.push({ path: `${s.folder}/Dockerfile`, language: "dockerfile", content: df.content, service: s.name });
      files.push(...df.extra);
      files.push({ path: `${s.folder}/.dockerignore`, language: "text", content: dockerignoreFor(s), service: s.name });
      out.push(`    build: ./${s.folder}`);
      out.push(`    ports:`);
      out.push(`      - "${s.hostPort}:${port}"`);
      urls.push({ service: s.name, url: `http://localhost:${s.hostPort}` });

      const env: [string, string][] = [];
      if (t.kind === "backend") {
        env.push(["PORT", String(port)]);
        // Two databases would both hand out DATABASE_URL; compose rejects duplicate
        // keys, so later ones are prefixed with their service name (DB2_DATABASE_URL).
        const used = new Set(env.map(([k]) => k));
        for (const d of data) {
          for (const [key, value] of d.envForApps) {
            const name = used.has(key) ? `${d.s.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${key}` : key;
            used.add(name);
            env.push([name, value]);
          }
        }
      }
      if (t.kind === "frontend" && backends.length) {
        // The browser calls the API from your machine, so this is the published localhost port.
        const api = backends[0];
        const key = s.template === "nextjs" ? "NEXT_PUBLIC_API_URL" : "VITE_API_URL";
        env.push([key, proxy ? `http://localhost:${proxy.hostPort}/api` : `http://localhost:${api.hostPort}`]);
      }
      if (env.length) {
        out.push(`    environment:`);
        for (const [k, v] of env) out.push(`      ${k}: ${yamlScalar(v)}`);
      }
      if (dev) {
        out.push(`    volumes:`);
        out.push(`      - ./${s.folder}:/app`);
        if (["nextjs", "react-vite", "vue-vite", "express", "nestjs"].includes(s.template)) {
          out.push(`      - /app/node_modules`);
          if (s.template === "nextjs") out.push(`      - /app/.next`);
        }
        if (s.template === "rust") out.push(`      - /app/target`);
      }
      const deps = t.kind === "backend" ? data.map((d) => d.s) : backends;
      if (deps.length) {
        out.push(`    depends_on:`);
        for (const d of deps) {
          const healthy = ["database", "cache", "queue"].includes(templateById(d.template)!.kind);
          out.push(`      ${d.name}:`);
          out.push(`        condition: ${healthy ? "service_healthy" : "service_started"}`);
        }
      }
      if (!dev) out.push(`    restart: unless-stopped`);
    } else if (s.template === "postgres") {
      const db = str(s, "database") || "app";
      out.push(`    image: postgres:${str(s, "version")}-alpine`);
      out.push(`    environment:`);
      out.push(`      POSTGRES_USER: \${POSTGRES_USER:-app}`);
      out.push(`      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-app}`);
      out.push(`      POSTGRES_DB: \${POSTGRES_DB:-${db}}`);
      if (opt(s, "publish") !== false) { out.push(`    ports:`, `      - "${s.hostPort}:5432"`); }
      out.push(`    volumes:`, `      - ${s.name}-data:/var/lib/postgresql/data`);
      out.push(`    healthcheck:`, `      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-app} -d \${POSTGRES_DB:-${db}}"]`, `      interval: 5s`, `      timeout: 5s`, `      retries: 10`);
      volumes.push(`${s.name}-data`);
      envExample.push(`POSTGRES_USER=app`, `POSTGRES_PASSWORD=change-me`, `POSTGRES_DB=${db}`);
    } else if (s.template === "mysql") {
      const db = str(s, "database") || "app";
      out.push(`    image: mysql:${str(s, "version")}`);
      out.push(`    environment:`);
      out.push(`      MYSQL_DATABASE: \${MYSQL_DATABASE:-${db}}`);
      out.push(`      MYSQL_USER: \${MYSQL_USER:-app}`);
      out.push(`      MYSQL_PASSWORD: \${MYSQL_PASSWORD:-app}`);
      out.push(`      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:-root}`);
      if (opt(s, "publish") !== false) { out.push(`    ports:`, `      - "${s.hostPort}:3306"`); }
      out.push(`    volumes:`, `      - ${s.name}-data:/var/lib/mysql`);
      out.push(`    healthcheck:`, `      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]`, `      interval: 5s`, `      timeout: 5s`, `      retries: 20`);
      volumes.push(`${s.name}-data`);
      envExample.push(`MYSQL_DATABASE=${db}`, `MYSQL_USER=app`, `MYSQL_PASSWORD=change-me`, `MYSQL_ROOT_PASSWORD=change-me-too`);
    } else if (s.template === "mongo") {
      out.push(`    image: mongo:${str(s, "version")}`);
      out.push(`    environment:`);
      out.push(`      MONGO_INITDB_ROOT_USERNAME: \${MONGO_USER:-app}`);
      out.push(`      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_PASSWORD:-app}`);
      if (opt(s, "publish") !== false) { out.push(`    ports:`, `      - "${s.hostPort}:27017"`); }
      out.push(`    volumes:`, `      - ${s.name}-data:/data/db`);
      out.push(`    healthcheck:`, `      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]`, `      interval: 5s`, `      timeout: 5s`, `      retries: 20`);
      volumes.push(`${s.name}-data`);
      envExample.push(`MONGO_USER=app`, `MONGO_PASSWORD=change-me`);
    } else if (s.template === "redis") {
      out.push(`    image: redis:${str(s, "version")}-alpine`);
      if (opt(s, "persist") === true) {
        out.push(`    command: ["redis-server", "--appendonly", "yes"]`);
        out.push(`    volumes:`, `      - ${s.name}-data:/data`);
        volumes.push(`${s.name}-data`);
      }
      out.push(`    healthcheck:`, `      test: ["CMD", "redis-cli", "ping"]`, `      interval: 5s`, `      timeout: 3s`, `      retries: 10`);
    } else if (s.template === "rabbitmq") {
      out.push(`    image: rabbitmq:3-management-alpine`);
      out.push(`    environment:`);
      out.push(`      RABBITMQ_DEFAULT_USER: \${RABBITMQ_USER:-app}`);
      out.push(`      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_PASSWORD:-app}`);
      out.push(`    ports:`, `      - "${s.hostPort}:15672"`);
      out.push(`    volumes:`, `      - ${s.name}-data:/var/lib/rabbitmq`);
      out.push(`    healthcheck:`, `      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]`, `      interval: 10s`, `      timeout: 10s`, `      retries: 10`);
      volumes.push(`${s.name}-data`);
      envExample.push(`RABBITMQ_USER=app`, `RABBITMQ_PASSWORD=change-me`);
      urls.push({ service: `${s.name} dashboard`, url: `http://localhost:${s.hostPort}` });
    } else if (s.template === "nginx") {
      out.push(`    image: nginx:1.27-alpine`);
      out.push(`    ports:`, `      - "${s.hostPort}:80"`);
      out.push(`    volumes:`, `      - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro`);
      const upstream = [...frontends, ...backends];
      if (upstream.length) {
        out.push(`    depends_on:`);
        for (const u of upstream) out.push(`      - ${u.name}`);
      }
      files.push({ path: "nginx/nginx.conf", language: "nginx", service: s.name, content: nginxProxyConf(frontends[0], backends[0], stack.mode) });
      urls.unshift({ service: `${s.name} (everything)`, url: `http://localhost:${s.hostPort}` });
    } else if (s.template === "adminer") {
      out.push(`    image: adminer:4`);
      out.push(`    ports:`, `      - "${s.hostPort}:8080"`);
      if (sqlDbs.length) {
        out.push(`    environment:`, `      ADMINER_DEFAULT_SERVER: ${sqlDbs[0].name}`);
        out.push(`    depends_on:`);
        for (const d of sqlDbs) out.push(`      - ${d.name}`);
      } else {
        warnings.push("Adminer needs a PostgreSQL or MySQL service to browse.");
      }
      urls.push({ service: s.name, url: `http://localhost:${s.hostPort}` });
    }
    out.push(``);
  }

  if (volumes.length) {
    out.push(`volumes:`);
    for (const v of volumes) out.push(`  ${v}:`);
  } else {
    while (out.length && out[out.length - 1] === "") out.pop();
  }

  if (services.length) {
    files.unshift({ path: "docker-compose.yml", language: "yaml", content: out.join("\n").replace(/\n+$/, "") + "\n" });
  }
  if (envExample.length) {
    files.push({
      path: ".env.example",
      language: "ini",
      content: lines("# Copy to .env and change the passwords. Compose reads .env automatically;", "# without it the defaults in docker-compose.yml are used.", ...envExample),
    });
  }

  for (const f of frontends) {
    if (f.template === "nextjs" && !dev) {
      warnings.push(`${f.name}: set output: "standalone" in next.config so the production image can start with node server.js.`);
    }
  }
  if (!apps.length && services.length) {
    warnings.push("No app service yet - add a frontend or backend to build your own code.");
  }

  const guide = buildGuide(stack, services, urls);
  if (services.length) {
    files.push({ path: "DOCKER.md", language: "markdown", content: guideMarkdown(stack, guide, urls) });
  }
  return { files, guide, warnings, urls };
}

function nginxProxyConf(frontend: StackService | undefined, backend: StackService | undefined, mode: Stack["mode"]): string {
  const block: string[] = ["# One entry point: /api goes to the backend, everything else to the frontend.", "server {", "  listen 80;"];
  if (backend) {
    block.push(
      "  location /api/ {",
      `    proxy_pass http://${backend.name}:${containerPort(backend, mode)}/;`,
      "    proxy_set_header Host $host;",
      "    proxy_set_header X-Real-IP $remote_addr;",
      "  }",
    );
  }
  if (frontend) {
    block.push(
      "  location / {",
      `    proxy_pass http://${frontend.name}:${containerPort(frontend, mode)};`,
      "    proxy_set_header Host $host;",
      "    proxy_http_version 1.1;",
      "    proxy_set_header Upgrade $http_upgrade;",
      '    proxy_set_header Connection "upgrade";',
      "  }",
    );
  }
  block.push("}");
  return block.join("\n") + "\n";
}

/* ------------------------------------------------------------------ guide */

function scaffoldFor(s: StackService): string[] {
  const f = s.folder;
  switch (s.template) {
    case "nextjs": return [`npx create-next-app@latest ${f}`];
    case "react-vite": return [`npm create vite@latest ${f} -- --template react`, `cd ${f} && npm install && cd ..`];
    case "vue-vite": return [`npm create vite@latest ${f} -- --template vue`, `cd ${f} && npm install && cd ..`];
    case "go": return [`mkdir -p ${f} && cd ${f} && go mod init example.com/${s.name} && cd ..`];
    case "express": return [`mkdir -p ${f} && cd ${f} && npm init -y && npm install express && cd ..`];
    case "nestjs": return [`npx @nestjs/cli new ${f}`];
    case "fastapi": return [`mkdir -p ${f} && printf "fastapi\\nuvicorn[standard]\\n" > ${f}/requirements.txt`];
    case "django": return [`mkdir -p ${f} && printf "django\\ngunicorn\\n" > ${f}/requirements.txt`];
    case "springboot": return [`# create a Maven project at https://start.spring.io and unzip it into ./${f}`];
    case "rust": return [`cargo new ${f} --name ${String(opt(s, "bin") || "app")}`];
    default: return [];
  }
}

function buildGuide(stack: Stack, services: StackService[], urls: GeneratedStack["urls"]): GuideStep[] {
  if (!services.length) return [];
  const steps: GuideStep[] = [];
  const apps = services.filter((s) => ["frontend", "backend"].includes(templateById(s.template)!.kind));
  const dev = stack.mode === "development";

  steps.push({ title: "Install Docker", commands: ["docker --version", "docker compose version"], note: "Install Docker Desktop first; both commands should print a version." });
  if (apps.length) {
    steps.push({
      title: "Create the app folders (skip any you already have)",
      commands: apps.flatMap(scaffoldFor),
      note: apps.some((a) => ["nextjs", "react-vite", "vue-vite", "express", "nestjs"].includes(a.template))
        ? "Node apps need a lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock) - installing once locally creates it."
        : undefined,
    });
  }
  const specifics: string[] = [];
  for (const a of apps) {
    if (a.template === "go") specifics.push(`${a.name}: the server must listen on 0.0.0.0:${containerPort(a, stack.mode)} (not 127.0.0.1) to be reachable.`);
    if (a.template === "nextjs" && !dev) specifics.push(`${a.name}: add output: "standalone" to next.config.`);
    if (a.template === "express") specifics.push(`${a.name}: listen on process.env.PORT and host 0.0.0.0.`);
    if (a.template === "fastapi") specifics.push(`${a.name}: put your FastAPI object in ${String(opt(a, "app")).split(":")[0]}.py.`);
  }
  steps.push({ title: "Put the generated files in place", commands: ["cp .env.example .env"], note: specifics.join(" ") || undefined });
  steps.push({ title: "Build and start everything", commands: ["docker compose up --build"], note: dev ? "Code folders are mounted, so edits reload without rebuilding." : "Rebuild after code changes: docker compose up --build -d." });
  if (urls.length) steps.push({ title: "Open it", commands: urls.map((u) => `${u.service}: ${u.url}`) });
  steps.push({
    title: "Everyday commands",
    commands: [
      "docker compose ps",
      "docker compose logs -f " + (apps[0] ? apps[0].name : services[0].name),
      "docker compose restart " + (apps[0] ? apps[0].name : services[0].name),
      "docker compose down",
    ],
  });
  if (services.some((s) => ["postgres", "mysql", "mongo", "rabbitmq"].includes(s.template) || opt(s, "persist") === true)) {
    steps.push({ title: "Start over with empty databases", commands: ["docker compose down -v"], note: "-v deletes the database volumes - all data is gone." });
  }
  return steps;
}

function guideMarkdown(stack: Stack, guide: GuideStep[], urls: GeneratedStack["urls"]): string {
  const out = [`# Running ${stack.projectName || "this project"} with Docker`, "", `Generated by Blast Radius (${stack.mode} setup).`, ""];
  guide.forEach((step, i) => {
    out.push(`## ${i + 1}. ${step.title}`, "");
    if (step.title === "Open it") {
      for (const u of urls) out.push(`- ${u.service}: ${u.url}`);
    } else {
      out.push("```sh", ...step.commands, "```");
    }
    if (step.note) out.push("", step.note);
    out.push("");
  });
  return out.join("\n");
}

/** Host ports a service publishes on your machine. */
function publishedHostPorts(s: StackService): number[] {
  const t = templateById(s.template);
  if (!t) return [];
  if (t.kind === "cache") return [];
  if (t.kind === "database") return opt(s, "publish") === false ? [] : [s.hostPort];
  return [s.hostPort];
}

/** Next free host port for a new service, avoiding ports already taken in the stack. */
export function suggestHostPort(template: string, stack: Stack): number {
  const t = templateById(template);
  if (!t) return 8000;
  const taken = new Set(stack.services.map((s) => s.hostPort));
  let port = stack.mode === "development" && t.devPort ? t.devPort : t.port === 80 ? 8080 : t.port;
  if (t.id === "adminer") port = 8081;
  if (t.id === "rabbitmq") port = 15672; // the dashboard; apps reach the broker inside Docker
  while (taken.has(port)) port++;
  return port;
}

/** A unique service name and folder for a newly added template. */
export function newService(template: string, stack: Stack, id: string): StackService {
  const t = templateById(template)!;
  const names = new Set(stack.services.map((s) => s.name));
  const folders = new Set(stack.services.map((s) => s.folder));
  let name = t.defaultName;
  for (let n = 2; names.has(name); n++) name = `${t.defaultName}${n}`;
  let folder = t.defaultFolder || "";
  if (folder) {
    const base = folder;
    for (let n = 2; folders.has(folder); n++) folder = `${base}${n}`;
  }
  return { id, template, name, folder, hostPort: suggestHostPort(template, stack), options: {} };
}

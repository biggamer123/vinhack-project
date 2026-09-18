/**
 * Dev helper: verify the DEVOPS tab's analyzer and project builder.
 *
 *   npm run compile && node scripts/check-devops.js             # offline checks
 *   node scripts/check-devops.js --network                      # also confirm every image tag exists on its registry
 *
 * Analyzer: a fixture repo covering compose edge cases, plus the real
 * railway-software project when it is present on this machine.
 * Builder: every template in both modes with every option choice, then whole
 * stacks validated by Docker itself with `docker compose config` (no daemon
 * needed).
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");
const { analyzeProject, parseDockerfileText } = require("../out/devops");
const T = require("../out/dockerTemplates");

let failures = 0;
function check(label, actual, expected) {
  const ok = expected === undefined ? !!actual : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/* ============================================================= analyzer */
function analyzerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blast-radius-devops-"));
  write(root, "docker-compose.yml", [
    "services:",
    "  db:",
    "    image: postgres",
    "    environment:",
    "      - POSTGRES_PASSWORD=supersecret",
    "      - POSTGRES_DB",
    "  cache:",
    "    image: redis:7-alpine",
    "  api:",
    "    build:",
    "      context: ./services/api",
    "      dockerfile: Dockerfile.prod",
    "    ports:",
    "      - target: 9000",
    "        published: 9001",
    "    environment:",
    "      DB_URL: postgres://u:p@db:5432/x",
    "      CACHE: http://localhost:6379",
    "      TOKEN: ${API_TOKEN}",
    "    volumes:",
    "      - type: bind",
    "        source: ./services/api",
    "        target: /srv",
    "      - logs:/var/log/api:ro",
    "    depends_on:",
    "      db:",
    "        condition: service_healthy",
    "      ghost:",
    "        condition: service_started",
    "  web:",
    "    build: ./web",
    "    ports: [\"127.0.0.1:3000:3000\", \"5555\"]",
    "    depends_on: [cache]",
    "",
  ].join("\n"));
  write(root, "services/api/Dockerfile.prod", [
    "# build stage",
    "FROM golang:1.23-alpine AS build",
    "WORKDIR /src",
    "COPY . .",
    "RUN go mod download && \\",
    "    CGO_ENABLED=0 go build -o /out/app .",
    "FROM gcr.io/distroless/static-debian12:nonroot",
    "COPY --from=build /out/app /app",
    "USER nonroot",
    "EXPOSE 9000 9100",
    'ENTRYPOINT ["/app"]',
  ].join("\n"));
  write(root, "services/api/go.mod", "module x\n");
  write(root, "Dockerfile", "FROM node:latest\nCOPY . .\nRUN npm ci\nCMD node index.js\n");
  write(root, "package.json", '{"dependencies":{"express":"4"}}');
  write(root, "worker/requirements.txt", "fastapi\n");
  write(root, "broken/docker-compose.yml", "services:\n  a: [unclosed\n");

  const r = analyzeProject(root);
  const main = r.composeFiles.find((c) => c.path === "docker-compose.yml");
  const svc = (n) => main.services.find((s) => s.name === n);
  const titles = (n) => svc(n).findings.map((f) => f.title);

  check("finds both compose files", r.composeFiles.map((c) => c.path).sort(), ["broken/docker-compose.yml", "docker-compose.yml"]);
  check("broken compose reports its parse error", !!r.composeFiles.find((c) => c.path.startsWith("broken")).error, true);
  check("four services", main.services.map((s) => s.name), ["db", "cache", "api", "web"]);
  check("custom dockerfile name is linked", svc("api").build.dockerfilePath, path.join("services", "api", "Dockerfile.prod"));
  check("linked dockerfile is parsed", svc("api").dockerfile && svc("api").dockerfile.stages.length, 2);
  check("multi-stage production image detected", svc("api").dockerfile.purpose, "production");
  check("line continuations join into one RUN", svc("api").dockerfile.instructions.filter((i) => i.op === "RUN").length, 1);
  check("long-form port parsed", svc("api").ports[0], { host: "9001", container: "9000", protocol: "tcp", raw: svc("api").ports[0].raw });
  check("short ports with host IP and none", svc("web").ports.map((p) => [p.host, p.container]), [["3000", "3000"], [null, "5555"]]);
  check("bind, named read-only volumes", svc("api").volumes.map((v) => [v.kind, v.readOnly]), [["bind", false], ["named", true]]);
  check("env list and map forms", svc("db").environment.map((e) => e.key), ["POSTGRES_PASSWORD", "POSTGRES_DB"]);
  check("secret values are masked", svc("db").environment[0].value, "****");
  check("passwords inside URLs are masked", svc("api").environment[0].value, "postgres://u:****@db:5432/x");
  check("${VAR} references are not flagged as hardcoded", titles("api").filter((t) => t === "Password in compose").length, 1);
  check("depends_on conditions parsed", svc("api").dependsOn, [{ name: "db", condition: "service_healthy" }, { name: "ghost", condition: "service_started" }]);
  check("missing dependency flagged", titles("api").includes("Depends on missing service"), true);
  check("localhost inside a container flagged", titles("api").includes("localhost in a container"), true);
  check("undeclared named volume flagged", titles("api").includes("Undeclared volume"), true);
  check("exposed-but-unpublished port flagged", titles("api").includes("EXPOSE not published"), true);
  check("database without volume flagged", titles("db").includes("No volume - data lost on recreate"), true);
  check("unpinned image flagged", titles("db").includes("Image not pinned"), true);
  check("healthy condition is not a readiness warning", titles("api").includes("No readiness wait"), false);
  check("missing Dockerfile flagged", titles("web").includes("Dockerfile missing"), true);
  check("root Dockerfile is standalone", r.standaloneDockerfiles.map((d) => d.path), ["Dockerfile"]);
  const rootDf = r.standaloneDockerfiles[0];
  check("root Dockerfile: :latest flagged", rootDf.findings.some((f) => f.title === "Base image :latest"), true);
  check("root Dockerfile: COPY . . before install flagged", rootDf.findings.some((f) => f.title === "COPY . . before install"), true);
  check("root Dockerfile: missing .dockerignore flagged", rootDf.findings.some((f) => f.title === "No .dockerignore"), true);
  check("shell-form CMD kept as written", rootDf.cmd, "node index.js");
  check("loose app found", r.looseApps.map((a) => `${a.path}:${a.tech.id}`), ["worker:fastapi"]);
  check("service block is the real compose lines", svc("cache").block, "  cache:\n    image: redis:7-alpine");
  check("standalone Dockerfile gets build/run commands", r.commands.some((c) => c.command.startsWith("docker build")), true);
  fs.rmSync(root, { recursive: true, force: true });
}

function analyzerRealProject() {
  const root = path.join(os.homedir(), "Desktop", "Web Development", "railway-software");
  if (!fs.existsSync(path.join(root, "docker-compose.yml"))) {
    console.log("SKIP  railway-software not on this machine");
    return;
  }
  const r = analyzeProject(root);
  const svcs = r.composeFiles[0].services;
  const s = (n) => svcs.find((x) => x.name === n);
  check("railway: four services", svcs.map((x) => `${x.name}:${x.tech && x.tech.id}`), ["postgres:postgres", "redis:redis", "api:go", "web:nextjs"]);
  check("railway: apps linked to their Dockerfiles", [s("api").build.dockerfilePath, s("web").build.dockerfilePath], [path.join("backend", "Dockerfile"), path.join("frontend", "Dockerfile")]);
  check("railway: dev images recognised", [s("api").dockerfile.purpose, s("web").dockerfile.purpose], ["development", "development"]);
  check("railway: api readiness warning", s("api").findings.some((f) => f.title === "No readiness wait"), true);
  check("railway: air @latest flagged", s("api").findings.some((f) => f.title === "Tool pinned to @latest"), true);
  check("railway: postgres has its volume", s("postgres").volumes[0].source, "pgdata");
  check("railway: web anonymous volumes", s("web").volumes.filter((v) => v.kind === "anonymous").length, 2);
  check("railway: nothing loose", r.looseApps.length, 0);
}

/* ============================================================== builder */
let idCounter = 0;
function stackOf(mode, templates, tweak) {
  const stack = { projectName: "demo", mode, services: [] };
  for (const t of templates) {
    const s = T.newService(t, stack, `s${idCounter++}`);
    if (tweak) tweak(s);
    stack.services.push(s);
  }
  return stack;
}

function images(gen) {
  const out = new Set();
  for (const f of gen.files) {
    if (f.path.endsWith("Dockerfile")) {
      for (const ins of parseDockerfileText(f.content)) {
        if (ins.op === "FROM") out.add(ins.args.split(/\s+/)[0]);
      }
    }
    if (f.path === "docker-compose.yml") {
      const doc = YAML.parse(f.content);
      for (const s of Object.values(doc.services || {})) if (s.image) out.add(s.image);
    }
  }
  return out;
}

function builderMatrix(allImages) {
  let generated = 0;
  let dockerfileProblems = [];
  for (const def of T.CATALOG) {
    const choiceSets = [{}];
    for (const o of def.options) {
      if (o.type === "select") {
        const next = [];
        for (const base of choiceSets) for (const c of o.choices) next.push({ ...base, [o.key]: c });
        choiceSets.splice(0, choiceSets.length, ...next);
      }
    }
    for (const mode of ["development", "production"]) {
      for (const options of choiceSets) {
        const stack = stackOf(mode, [def.id], (s) => (s.options = { ...options }));
        const gen = T.generateStack(stack);
        generated++;
        images(gen).forEach((i) => allImages.add(i));
        const compose = gen.files.find((f) => f.path === "docker-compose.yml");
        try {
          YAML.parse(compose.content);
        } catch (e) {
          dockerfileProblems.push(`${def.id}/${mode}: compose YAML ${e.message}`);
        }
        for (const f of gen.files.filter((x) => x.path.endsWith("Dockerfile"))) {
          const ins = parseDockerfileText(f.content);
          if (ins[0].op !== "FROM") dockerfileProblems.push(`${def.id}/${mode}: first instruction ${ins[0].op}`);
          const known = new Set(["FROM", "WORKDIR", "COPY", "RUN", "ENV", "EXPOSE", "CMD", "ENTRYPOINT", "USER", "ARG"]);
          for (const i of ins) if (!known.has(i.op)) dockerfileProblems.push(`${def.id}/${mode}: unexpected ${i.op}`);
          const cmds = ins.filter((i) => i.op === "CMD" || i.op === "ENTRYPOINT");
          for (const c of cmds) {
            if (c.args.startsWith("[")) {
              try { JSON.parse(c.args); } catch { dockerfileProblems.push(`${def.id}/${mode}: invalid exec-form ${c.args}`); }
            }
          }
          if (/@latest\b/.test(f.content)) dockerfileProblems.push(`${def.id}/${mode}: uses @latest`);
          if (!cmds.length && def.id !== "react-vite" && def.id !== "vue-vite") dockerfileProblems.push(`${def.id}/${mode}: no CMD/ENTRYPOINT`);
        }
      }
    }
  }
  check(`every template x mode x option combination generates (${generated})`, generated > 40, true);
  check("generated Dockerfiles are well-formed, pinned and start something", dockerfileProblems, []);
}

function builderStacks() {
  const haveDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
  const stacks = [
    ["go + next.js + postgres (development)", stackOf("development", ["go", "nextjs", "postgres"])],
    ["go + next.js + postgres (production)", stackOf("production", ["go", "nextjs", "postgres"])],
    ["fastapi + react + mongo + redis + rabbitmq", stackOf("development", ["fastapi", "react-vite", "mongo", "redis", "rabbitmq"])],
    ["nestjs + vue + mysql + adminer + nginx (production)", stackOf("production", ["nestjs", "vue-vite", "mysql", "adminer", "nginx"])],
    ["everything at once", stackOf("development", T.CATALOG.map((t) => t.id))],
  ];

  for (const [label, stack] of stacks) {
    const gen = T.generateStack(stack);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blast-radius-stack-"));
    for (const f of gen.files) write(dir, f.path, f.content);
    const compose = YAML.parse(gen.files.find((f) => f.path === "docker-compose.yml").content);

    const hostPorts = [];
    for (const s of Object.values(compose.services)) for (const p of s.ports || []) hostPorts.push(String(p).split(":")[0]);
    check(`${label}: no host port used twice`, new Set(hostPorts).size, hostPorts.length);

    for (const s of stack.services) {
      const kind = T.templateById(s.template).kind;
      if (kind === "frontend" || kind === "backend") {
        check(`${label}: ${s.name} has Dockerfile + .dockerignore`, ["Dockerfile", ".dockerignore"].every((n) => gen.files.some((f) => f.path === `${s.folder}/${n}`)), true);
      }
    }
    for (const [name, svc] of Object.entries(compose.services)) {
      for (const [dep, cond] of Object.entries(svc.depends_on && !Array.isArray(svc.depends_on) ? svc.depends_on : {})) {
        if (cond.condition === "service_healthy") {
          check(`${label}: ${name} waits for ${dep}, which has a healthcheck`, !!compose.services[dep].healthcheck, true);
        }
      }
    }
    if (haveDocker) {
      const res = spawnSync("docker", ["compose", "config", "-q"], { cwd: dir, encoding: "utf8" });
      check(`${label}: docker compose config accepts it`, res.status === 0 ? "valid" : (res.stderr || res.stdout).trim(), "valid");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!haveDocker) console.log("SKIP  docker compose not installed - YAML structure checked only");

  // backend gets connection env for the data services, frontend points the browser at localhost
  const g = T.generateStack(stackOf("development", ["go", "nextjs", "postgres", "redis"]));
  const doc = YAML.parse(g.files.find((f) => f.path === "docker-compose.yml").content);
  check("backend gets DATABASE_URL pointing at the db service by name", /@db:5432\//.test(doc.services.api.environment.DATABASE_URL), true);
  check("backend gets REDIS_URL", doc.services.api.environment.REDIS_URL, "redis://redis:6379");
  check("frontend points the browser at the API's localhost port", doc.services.web.environment.NEXT_PUBLIC_API_URL, "http://localhost:8080");
  check("development mounts code and keeps node_modules in the container", doc.services.web.volumes, ["./frontend:/app", "/app/node_modules", "/app/.next"]);
  check("postgres data survives in a named volume", Object.keys(doc.volumes), ["db-data"]);
  check(".env.example written", g.files.some((f) => f.path === ".env.example"), true);
  check("guide ends with the destructive reset step, flagged", g.guide[g.guide.length - 1].commands[0], "docker compose down -v");
  check("DOCKER.md written", g.files.some((f) => f.path === "DOCKER.md"), true);

  const clash = T.generateStack({ projectName: "x", mode: "development", services: [
    { id: "a", template: "go", name: "api", folder: "backend", hostPort: 8080, options: {} },
    { id: "b", template: "express", name: "api", folder: "backend", hostPort: 8080, options: {} },
  ] });
  check("duplicate names, ports and folders are warned about", clash.warnings.length, 3);

  const two = stackOf("development", ["postgres", "postgres"]);
  check("adding the same template twice picks a new name and port", [two.services[1].name, two.services[1].hostPort], ["db2", 5433]);
  const twoDbs = YAML.parse(T.generateStack(stackOf("development", ["go", "postgres", "mysql"])).files[0].content);
  check("two databases get distinct connection variables", Object.keys(twoDbs.services.api.environment), ["PORT", "DATABASE_URL", "DB2_DATABASE_URL"]);
  check("an empty stack generates nothing", T.generateStack({ projectName: "x", mode: "development", services: [] }).files.length, 0);
}

function tagExists(image) {
  if (image.startsWith("gcr.io/")) {
    const [repo, tag] = image.replace("gcr.io/", "").split(":");
    const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20",
      "-H", "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json",
      `https://gcr.io/v2/${repo}/manifests/${tag}`], { encoding: "utf8" });
    return r.stdout.trim() === "200";
  }
  const [name, tag = "latest"] = image.split(":");
  const repo = name.includes("/") ? name : `library/${name}`;
  const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20",
    `https://hub.docker.com/v2/repositories/${repo}/tags/${tag}`], { encoding: "utf8" });
  return r.stdout.trim() === "200";
}

(async () => {
  analyzerFixture();
  analyzerRealProject();
  const allImages = new Set();
  builderMatrix(allImages);
  builderStacks();
  if (process.argv.includes("--network")) {
    const missing = [...allImages].filter((i) => !tagExists(i));
    check(`every image the builder can produce exists (${allImages.size} checked)`, missing, []);
  } else {
    console.log(`SKIP  image tag lookups (${allImages.size} images) - pass --network to check them`);
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall devops checks passed");
  process.exit(failures ? 1 : 0);
})();

/**
 * Blast Radius - Stages 1-3.
 *
 *   Stage 1: tree-sitter call graph + inline caller-count badges
 *   Stage 2: risk scoring (fan-in, coverage, churn, bus factor)
 *   Stage 3: full call graph as a Pokedex-styled webview
 *
 * Everything here is deterministic: tree-sitter, lcov parsing, git log, set
 * arithmetic. No AI calls anywhere in these stages.
 */
import * as vscode from "vscode";
import { RiskCodeLensProvider, RiskHoverProvider } from "./codelens";
import { CallGraph } from "./graph";
import {
  dialectFor,
  indexSource,
  initParser,
  isParserReady,
  loadedDialects,
} from "./indexer";
import { RiskService } from "./risk";
import { detectDatabaseSchemas, schemaDiagramHtml } from "./schema";
import { BackupsController } from "./backupsController";
import { exportAllFeatureDocs, GraphPanel, openInBrowser } from "./webview";

/** Every dialect the bundled grammars can parse. */
const SOURCE_GLOB = "**/*.{js,jsx,mjs,cjs,ts,mts,cts,tsx,go}";
const EXCLUDE_GLOB =
  "**/{node_modules,dist,build,out,.git,coverage,.next,.nuxt,.turbo,.svelte-kit,vendor,__generated__}/**";

/** Editor languages the CodeLens and hover attach to. */
const LANGUAGES = [
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "go",
];

const graph = new CallGraph();
let backupsController: BackupsController;
let risk: RiskService;
let lensProvider: RiskCodeLensProvider;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  extensionContext = context;
  output = vscode.window.createOutputChannel("Blast Radius");
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "blastradius.showGraph";
  context.subscriptions.push(output, statusBar);
  log("activating…");

  risk = new RiskService(graph);

  // Local backups: opt-in per repository, resumed automatically once enabled.
  backupsController = new BackupsController(context, (m) => log(m));
  GraphPanel.backups = backupsController;
  context.subscriptions.push(
    backupsController,
    backupsController.onDidChange(() => GraphPanel.refreshBackups()),
  );
  void backupsController.start();
  lensProvider = new RiskCodeLensProvider(graph, risk);

  const selector = LANGUAGES.map((language) => ({ language, scheme: "file" }));
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(selector, lensProvider),
    vscode.languages.registerHoverProvider(
      selector,
      new RiskHoverProvider(graph, risk),
    ),
    risk.onDidChangeRisk(() => {
      lensProvider.refresh();
      GraphPanel.refresh();
      updateStatusBar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("blastradius.reindex", () =>
      indexWorkspace(),
    ),
    vscode.commands.registerCommand("blastradius.showStats", showStats),
    vscode.commands.registerCommand("blastradius.showCallers", showCallers),
    vscode.commands.registerCommand("blastradius.showGraph", (id?: string) => {
      GraphPanel.show(
        extensionContext,
        graph,
        risk,
        typeof id === "string" ? id : id ?? activeFunctionId(),
      );
    }),
    vscode.commands.registerCommand("blastradius.openInBrowser", () =>
      openInBrowser(extensionContext, graph, risk, activeFunctionId()),
    ),
    vscode.commands.registerCommand("blastradius.reloadCoverage", async () => {
      const root = workspaceRoot();
      if (root) {
        await risk.reloadCoverage(root);
        log(`reloaded coverage from ${risk.coverageSource}`);
      }
    }),
    vscode.commands.registerCommand("blastradius.tagCommit", tagCommitMessage),
    vscode.commands.registerCommand("blastradius.backupsEnable", () => backupsController.enable()),
    vscode.commands.registerCommand("blastradius.backupsDisable", () => backupsController.disable()),
    vscode.commands.registerCommand("blastradius.backupNow", () => backupsController.backupNow("manual", "manual backup")),
    vscode.commands.registerCommand("blastradius.exportFeatureDocs", () => exportAllFeatureDocs(graph, risk)),
    vscode.commands.registerCommand("blastradius.showSchemas", async () => {
      GraphPanel.toggleSchema();
    }),
  );

  // Incremental update: re-index just the saved file, then rebuild edges.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme !== "file" || !dialectFor(doc.uri.fsPath)) {
        return;
      }
      await reindexFile(doc.uri.fsPath, doc.getText());
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
  context.subscriptions.push(
    watcher,
    watcher.onDidDelete((uri) => {
      graph.removeFile(uri.fsPath);
      risk.invalidateFile(uri.fsPath);
      lensProvider.refresh();
      GraphPanel.refresh();
    }),
  );

  try {
    await initParser(context.extensionPath);
    log(`tree-sitter ready (grammars: ${loadedDialects().join(", ")})`);
  } catch (err) {
    log(`failed to initialize tree-sitter: ${err}`);
    vscode.window.showErrorMessage(
      `Blast Radius: could not load the tree-sitter parser - ${err}`,
    );
    return;
  }

  await indexWorkspace();
}

export function deactivate(): void {
  graph.clear();
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function activeFunctionId(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return undefined;
  }

  return graph.nodeAtLine(editor.document.uri.fsPath, editor.selection.active.line)?.id;
}

/** Full workspace scan, then a background pass for git history. */
async function indexWorkspace(): Promise<void> {
  if (!isParserReady()) {
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    log("no workspace folder open");
    return;
  }

  graph.clear();
  await risk.prepare(root);
  log(
    `coverage source: ${risk.coverageSource}; git history: ${risk.gitAvailable ? "available" : "unavailable"}`,
  );

  const files = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB);
  if (files.length === 0) {
    log(`no parseable source files found (looked for ${SOURCE_GLOB})`);
    vscode.window.showWarningMessage(
      "Blast Radius: no .js/.jsx/.ts/.tsx files found in this workspace.",
    );
    GraphPanel.refresh();
    return;
  }

  const started = Date.now();
  let parsed = 0;
  let failed = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Blast Radius: indexing",
    },
    async (progress) => {
      for (let i = 0; i < files.length; i++) {
        const uri = files[i];
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          graph.setFile(
            uri.fsPath,
            indexSource(uri.fsPath, Buffer.from(bytes).toString("utf8")),
          );
          parsed++;
        } catch (err) {
          failed++;
          log(`skipped ${uri.fsPath}: ${err}`);
        }

        // Resolve + refresh periodically so badges appear progressively.
        if (i % 25 === 24 || i === files.length - 1) {
          graph.resolveEdges();
          lensProvider.refresh();
          progress.report({ message: `${i + 1}/${files.length} files` });
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    },
  );

  graph.resolveEdges();
  lensProvider.refresh();
  GraphPanel.refresh();
  updateStatusBar();
  log(
    `indexed ${parsed} file(s)${failed ? ` (${failed} skipped)` : ""} - ` +
      `${graph.size} functions, ${graph.callSiteCount} call sites, ${Date.now() - started}ms`,
  );

  await hydrateGitHistory();
}

/** Background git pass - one `git log -L` per function, bounded concurrency. */
async function hydrateGitHistory(): Promise<void> {
  if (!risk.gitAvailable) {
    return;
  }
  const limit = vscode.workspace
    .getConfiguration("blastradius")
    .get<number>("maxGitFunctions", 800);
  const nodes = graph.allNodes();
  const started = Date.now();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Blast Radius: reading git history",
    },
    async (progress) => {
      await risk.hydrateGit(nodes, {
        limit,
        onProgress: (done, total) =>
          progress.report({ message: `${done}/${total} functions` }),
      });
    },
  );

  const scanned = Math.min(nodes.length, limit);
  log(
    `git history for ${scanned} function(s) in ${Date.now() - started}ms` +
      (nodes.length > limit
        ? ` (capped by blastradius.maxGitFunctions=${limit})`
        : ""),
  );
  lensProvider.refresh();
  GraphPanel.refresh();
  updateStatusBar();
}

/** Re-parse one file, rebuild edges, refresh its risk (including git). */
async function reindexFile(file: string, source: string): Promise<void> {
  if (!isParserReady()) {
    return;
  }
  const index = indexSource(file, source);
  graph.setFile(file, index);
  graph.resolveEdges();
  risk.invalidateFile(file);
  lensProvider.refresh();
  log(
    `re-indexed ${file} - ${index.nodes.length} functions, ${index.callSites.length} call sites`,
  );

  await risk.hydrateGit(graph.nodesInFile(file));
  lensProvider.refresh();
  GraphPanel.refresh();
  updateStatusBar();
}

function updateStatusBar(): void {
  const nodes = graph.allNodes();
  if (nodes.length === 0) {
    statusBar.hide();
    return;
  }
  const risky = nodes.filter((n) => risk.riskFor(n).score >= 30).length;
  statusBar.text = `$(flame) Blast Radius: ${risky} high-risk / ${nodes.length}`;
  statusBar.tooltip = "Open the Blast Radius call graph";
  statusBar.show();
}

async function showCallers(id?: string): Promise<void> {
  if (!id) {
    return;
  }
  const node = graph.getNode(id);
  if (!node) {
    return;
  }
  const callers = [...node.callers]
    .map((cid) => graph.getNode(cid))
    .filter(Boolean);
  if (callers.length === 0) {
    vscode.window.showInformationMessage(
      `${node.name} has no known callers in this workspace.`,
    );
    return;
  }

  const picks = callers.map((caller) => ({
    label: caller!.name,
    description: `${vscode.workspace.asRelativePath(caller!.file)}:${caller!.startLine + 1}`,
    detail: risk.summaryLine(caller!),
    node: caller!,
  }));
  const chosen = await vscode.window.showQuickPick(picks, {
    title: `Callers of ${node.name}`,
  });
  if (!chosen) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(chosen.node.file),
  );
  const position = new vscode.Position(chosen.node.startLine, 0);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(position, position),
  });
}

function showStats(): void {
  const nodes = graph
    .allNodes()
    .sort((a, b) => risk.riskFor(b).score - risk.riskFor(a).score);
  const top = nodes
    .slice(0, 15)
    .map(
      (n) =>
        `  ${risk.summaryLine(n)} - ${n.name} (${vscode.workspace.asRelativePath(n.file)}:${n.startLine + 1})`,
    )
    .join("\n");
  log(
    `\nGraph: ${nodes.length} functions, ${graph.callSiteCount} call sites\n` +
      `Coverage source: ${risk.coverageSource}\nRiskiest:\n${top}`,
  );
  output.show(true);
}

function log(message: string): void {
  output.appendLine(`[blast-radius] ${message}`);
}

/**
 * Help write a commit message in the features convention. Fills the Source
 * Control message box and stops there - committing stays the user's decision.
 */
async function tagCommitMessage(): Promise<void> {
  const types: { label: string; description: string; prefix: string }[] = [
    { label: "feature", description: "new capability", prefix: "feature" },
    { label: "bug fix", description: "something was broken", prefix: "bug fix" },
    { label: "hotfix", description: "urgent production fix", prefix: "hotfix" },
    { label: "refactor", description: "same behaviour, better code", prefix: "refactor" },
    { label: "performance", description: "faster or lighter", prefix: "perf" },
    { label: "security", description: "closes a hole", prefix: "security" },
    { label: "test", description: "tests only", prefix: "test" },
    { label: "docs", description: "documentation only", prefix: "docs" },
    { label: "style", description: "UI or formatting", prefix: "style" },
    { label: "chore", description: "tooling, build, deps", prefix: "chore" },
  ];
  const type = await vscode.window.showQuickPick(types, {
    title: "Blast Radius: commit type",
    placeHolder: "What kind of change is this?",
  });
  if (!type) {
    return;
  }

  const title = await vscode.window.showInputBox({
    title: `Blast Radius: ${type.label}`,
    prompt: "Name it the way you want it to appear in the FEATURES tab. Reuse the exact name to add to an existing feature.",
    placeHolder: "get users from db",
    validateInput: (v) => (v.trim() ? undefined : "A title is required"),
  });
  if (!title) {
    return;
  }

  const scope = await vscode.window.showInputBox({
    title: "Blast Radius: scope (optional)",
    prompt: "Group commits with different titles under one feature, e.g. \"users\". Leave empty to group by title.",
    placeHolder: "users",
  });
  if (scope === undefined) {
    return;
  }

  const message = `${type.prefix}${scope.trim() ? `(${scope.trim()})` : ""}: ${title.trim()}`;

  const gitExtension = vscode.extensions.getExtension("vscode.git");
  const api = gitExtension?.isActive
    ? gitExtension.exports.getAPI(1)
    : gitExtension
      ? (await gitExtension.activate()).getAPI(1)
      : undefined;
  const repo = api?.repositories?.[0];
  if (repo) {
    repo.inputBox.value = message;
    await vscode.commands.executeCommand("workbench.view.scm");
    vscode.window.showInformationMessage(`Commit message ready: "${message}" - review and commit when you are ready.`);
  } else {
    await vscode.env.clipboard.writeText(message);
    vscode.window.showInformationMessage(`No git repository open - copied "${message}" to the clipboard.`);
  }
}

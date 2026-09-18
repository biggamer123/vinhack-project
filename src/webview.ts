/**
 * Blast Radius - Stage 3: the full call graph as a Pokedex-styled webview.
 *
 * The page itself lives in media/graph.html (inline <style> + <script>, D3 from
 * cdnjs, no build step). Keeping it in its own file rather than a TypeScript
 * template literal avoids escaping every ${} the D3 code needs.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CallGraph } from "./graph";
import { RiskService, tierFor } from "./risk";
import { inferSchemaRelations, scanDatabaseSchemas } from "./schema";
import { buildFeatures, FeaturesPayload, FunctionRef, RawCommit, readCommits } from "./features";
import { findRepoRoot } from "./git";
import {
  assignFeatureFileNames,
  featureMarkdown,
  featuresIndexMarkdown,
  FunctionInfo,
  functionFileName,
  functionMarkdown,
  LlmContext,
} from "./llmContext";
import type { BackupsController, BackupsPayload } from "./backupsController";
import { PROTOCOL_VERSION } from "./protocol";
import { buildStandaloneHtml, servePage } from "./standalone";

interface WireNode {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  fanIn: number;
  fanOut: number;
  score: number;
  tier: string;
  risk: {
    fanIn: number;
    coveragePct: number | null;
    coverageIsProxy: boolean;
    churnCount: number;
    busFactor: number;
    /** Authors by commit count, descending. First entry is the lead changer. */
    authors: { name: string; email: string; commits: number }[];
    /** Epoch ms of the most recent commit touching this function, if known. */
    lastChange: number | null;
    /** Recent commits touching this function, for the GIT tab's charts and history. */
    commits: { hash: string; email: string; name: string; t: number; subject: string }[];
    testRefs: { file: string; line: number; name: string }[];
    gitResolved: boolean;
  };
}

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private schemaVisible = false;
  private schemaData: SchemaPayload | null = null;
  /** Raw commit log, read once per request - rebuilding features from it is cheap. */
  private featureCommits: RawCommit[] | null = null;
  private featuresRequested = false;
  private backupsRequested = false;
  private backupsData: BackupsPayload | null = null;
  private featuresError: string | undefined;

  /** Function the user clicked in a CodeLens, to select once the page is up. */
  focusId: string | undefined;

  static show(
    context: vscode.ExtensionContext,
    graph: CallGraph,
    risk: RiskService,
    focusId?: string,
  ): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      GraphPanel.current.focusId = focusId;
      GraphPanel.current.update();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "blastradius.graph",
      "Blast Radius",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    GraphPanel.current = new GraphPanel(panel, context, graph, risk);
    GraphPanel.current.focusId = focusId;
    return GraphPanel.current;
  }

  /** Push fresh data into an already-open panel (after a save or re-index). */
  /** Set by the extension on activation. */
  static backups: BackupsController | undefined;

  /** Push fresh backup data into an open panel that has asked for it. */
  static refreshBackups(): void {
    const panel = GraphPanel.current;
    if (panel && panel.backupsRequested) {
      void panel.loadBackups();
    }
  }

  static refresh(): void {
    GraphPanel.current?.update();
  }

  static toggleSchema(): void {
    void GraphPanel.current?.showSchemaView();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly graph: CallGraph,
    private readonly risk: RiskService,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private onMessage(msg: {
    type: string;
    id?: string;
    text?: string;
    force?: boolean;
    kind?: string;
    file?: string;
    line?: number;
  }): void {
    if (msg.type === "ready") {
      this.ready = true;
      this.update();
      return;
    }
    if (msg.type === "reveal" && msg.id) {
      this.reveal(msg.id);
      return;
    }
    if (msg.type === "revealTest" && msg.file) {
      void this.revealTest(msg.file, msg.line);
      return;
    }
    if (msg.type === "browser") {
      void openInBrowser(this.context, this.graph, this.risk, msg.id);
      return;
    }
    if (msg.type === "schema") {
      void this.showSchemaView();
      return;
    }
    if (msg.type === "backups") {
      void this.loadBackups();
      return;
    }
    if (msg.type === "backupsEnable") {
      void GraphPanel.backups?.enable();
      return;
    }
    if (msg.type === "backupsDisable") {
      void GraphPanel.backups?.disable();
      return;
    }
    if (msg.type === "backupNow") {
      void GraphPanel.backups?.backupNow("manual", "manual backup");
      return;
    }
    if (msg.type === "llmMd" && msg.id && (msg.kind === "feature" || msg.kind === "function")) {
      void this.sendLlmMarkdown(msg.kind, msg.id, false);
      return;
    }
    if (msg.type === "llmMdSave" && msg.id && (msg.kind === "feature" || msg.kind === "function")) {
      void this.sendLlmMarkdown(msg.kind, msg.id, true);
      return;
    }
    if (msg.type === "llmMdSaveAll") {
      void exportAllFeatureDocs(this.graph, this.risk);
      return;
    }
    if (msg.type === "copy" && typeof msg.text === "string") {
      void vscode.env.clipboard.writeText(msg.text);
      vscode.window.showInformationMessage("Blast Radius: command copied - paste it into a terminal at the repository.");
      return;
    }
    if (msg.type === "features") {
      void this.loadFeatures(!!msg.force);
    }
  }

  /**
   * Read the commit log for the features view. The log is cached; which
   * functions each feature touched is recomputed on every update, so features
   * fill in as per-function git history finishes loading in the background.
   */
  private async loadBackups(): Promise<void> {
    if (!this.ready || !GraphPanel.backups) {
      return;
    }
    this.backupsRequested = true;
    this.backupsData = await GraphPanel.backups.snapshot();
    this.update();
  }

  /** Build one Markdown document with real source, reply to the page, optionally save it. */
  private async sendLlmMarkdown(kind: "feature" | "function", id: string, save: boolean): Promise<void> {
    const ctx = await llmContextFor(this.graph, this.risk);
    const markdown = kind === "feature" ? featureMarkdown(id, ctx) : functionMarkdown(id, ctx);
    let savedTo: string | undefined;
    if (save) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage("Blast Radius: open a folder to save LLM documents.");
      } else {
        const name =
          kind === "feature"
            ? assignFeatureFileNames(ctx.features?.features || []).get(id) || "feature.md"
            : functionFileName(ctx.functions.get(id) || { name: "function", file: "unknown" });
        const target = path.join(root, LLM_DIR, kind === "feature" ? "features" : "functions", name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, markdown);
        savedTo = vscode.workspace.asRelativePath(target);
        await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false, viewColumn: vscode.ViewColumn.One });
      }
    }
    this.panel.webview.postMessage({ type: "llmMdResult", kind, id, markdown, savedTo });
  }

  private async loadFeatures(force: boolean): Promise<void> {
    if (!this.ready) {
      return;
    }
    this.featuresRequested = true;
    if (force || !this.featureCommits) {
      const read = await readFeatureCommits();
      this.featureCommits = read.commits;
      this.featuresError = read.error;
    }
    this.update();
  }

  /**
   * Detect database schemas and push them to the page. Always answers: the page
   * has its own SCHEMA tab now, so a second request must refresh it rather than
   * toggle it off. An empty workspace still gets a rendered "nothing found"
   * page, so the tab is never blank.
   */
  private async showSchemaView(): Promise<void> {
    if (!this.ready) {
      return;
    }
    this.schemaVisible = true;
    this.schemaData = await collectSchemas();
    this.update();
  }

  /** Jump the editor to a function the user clicked in the graph. */
  private async reveal(id: string): Promise<void> {
    const node = this.graph.getNode(id);
    if (!node) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(node.file),
    );
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const range = new vscode.Range(node.startLine, 0, node.endLine, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  /** Open a test case referenced by a function's coverage findings. */
  private async revealTest(file: string, line?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    if (typeof line === "number") {
      const start = Math.max(0, line);
      const range = new vscode.Range(start, 0, start, 0);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  }

  /** Serialize the current graph + risk data and send it to the page. */
  update(): void {
    if (!this.ready) {
      return;
    }
    const payload = serializeGraph(this.graph, this.risk);
    this.panel.webview.postMessage({
      ...payload,
      focus: this.focusId,
      protocol: PROTOCOL_VERSION,
      version: this.context.extension?.packageJSON?.version ?? "dev",
      viewMode: this.schemaVisible ? "schema" : "graph",
      schema: this.schemaData,
      backups: this.backupsData,
      features: this.featuresRequested
        ? featuresFor(this.graph, this.risk, this.featureCommits || [], this.featuresError)
        : null,
    });
    this.focusId = undefined; // one-shot: a later refresh should not yank the view back
  }

  private html(): string {
    const file = path.join(this.context.extensionPath, "media", "graph.html");
    const nonce = Array.from({ length: 24 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join("");
    return fs
      .readFileSync(file, "utf8")
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{cspSource\}\}/g, this.panel.webview.cspSource);
  }

  private dispose(): void {
    GraphPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

/** Tables, their fields and the relations between them, ready for the page. */
export interface SchemaPayload {
  tables: {
    name: string;
    kind: string;
    source: string;
    fields: { name: string; type: string; nullable: boolean; primaryKey: boolean }[];
  }[];
  relations: { from: string; to: string; label: string }[];
  filesScanned: number;
  usedFallback: boolean;
  root: string;
  error?: string;
}

/** Run schema detection over the open workspace and shape it for the page. */
/** Read every commit in the open workspace's repository. */
/** Where saved LLM documents go, relative to the workspace root. */
export const LLM_DIR = path.join(".blastradius", "llm");

/**
 * Assemble everything the Markdown generator needs from the live index: every
 * function with its risk and history, the features, and a reader for source.
 * Files are read fresh from disk, so saved edits are reflected.
 */
export async function llmContextFor(graph: CallGraph, risk: RiskService): Promise<LlmContext> {
  const functions = new Map<string, FunctionInfo>();
  for (const node of graph.allNodes()) {
    const info = risk.riskFor(node);
    functions.set(node.id, {
      id: node.id,
      name: node.name,
      file: vscode.workspace.asRelativePath(node.file),
      absFile: node.file,
      startLine: node.startLine,
      endLine: node.endLine,
      score: info.score,
      tier: tierFor(info.score),
      fanIn: info.fanIn,
      fanOut: node.callees.size,
      coverage: risk.coverageLabel(info),
      coverageIsProxy: info.coverageIsProxy,
      churnCount: info.churnCount,
      busFactor: info.busFactor,
      gitResolved: info.gitResolved,
      authors: info.authors,
      commits: info.commits.map((c) => ({ hash: c.hash, name: c.name, t: c.t, subject: c.subject })),
      callers: [...node.callers],
      callees: [...node.callees],
    });
  }
  const read = await readFeatureCommits();
  const cache = new Map<string, string[]>();
  return {
    functions,
    features: featuresFor(graph, risk, read.commits, read.error),
    generatedAt: new Date(),
    readLines: (absFile, start, end) => {
      try {
        let lines = cache.get(absFile);
        if (!lines) {
          lines = fs.readFileSync(absFile, "utf8").split(/\r?\n/);
          cache.set(absFile, lines);
        }
        return lines.slice(start, end + 1);
      } catch {
        return null;
      }
    },
  };
}

/** Write one document per feature plus FEATURES.md, then open the index. */
export async function exportAllFeatureDocs(graph: CallGraph, risk: RiskService): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage("Blast Radius: open a folder to export LLM documents.");
    return;
  }
  const ctx = await llmContextFor(graph, risk);
  const features = ctx.features?.features || [];
  if (!features.length) {
    vscode.window.showInformationMessage(
      "Blast Radius: no tagged commits yet, so there are no features to document. " +
        "Start commit messages with \"feature:\", \"bug fix:\" and so on.",
    );
    return;
  }
  const names = assignFeatureFileNames(features);
  const dir = path.join(root, LLM_DIR);
  fs.mkdirSync(path.join(dir, "features"), { recursive: true });
  for (const feature of features) {
    fs.writeFileSync(path.join(dir, "features", names.get(feature.key) as string), featureMarkdown(feature.key, ctx));
  }
  const index = path.join(dir, "FEATURES.md");
  fs.writeFileSync(index, featuresIndexMarkdown(features, ctx, names));
  await vscode.window.showTextDocument(vscode.Uri.file(index), { preview: false });
  vscode.window.showInformationMessage(
    `Blast Radius: wrote ${features.length} feature document${features.length === 1 ? "" : "s"} to ${vscode.workspace.asRelativePath(dir)}.`,
  );
}

export async function readFeatureCommits(): Promise<{ commits: RawCommit[]; error?: string }> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const repo = root ? await findRepoRoot(root) : undefined;
  if (!repo) {
    return { commits: [], error: "This workspace is not a git repository." };
  }
  try {
    return { commits: await readCommits(repo) };
  } catch (err) {
    return { commits: [], error: String(err) };
  }
}

/** Group commits into features, matching functions via their line history. */
export function featuresFor(
  graph: CallGraph,
  risk: RiskService,
  commits: RawCommit[],
  error?: string,
): FeaturesPayload {
  const refs: FunctionRef[] = graph.allNodes().map((node) => {
    const info = risk.riskFor(node);
    return {
      id: node.id,
      name: node.name,
      file: vscode.workspace.asRelativePath(node.file),
      startLine: node.startLine,
      score: info.score,
      tier: tierFor(info.score),
      commitHashes: info.commits.map((c) => c.hash),
    };
  });
  const payload = buildFeatures(commits, refs);
  if (error) {
    payload.error = error;
  }
  return payload;
}

export async function collectSchemas(): Promise<SchemaPayload> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  try {
    const scan = await scanDatabaseSchemas(root);
    return {
      tables: scan.schemas.map((schema) => ({
        name: schema.name,
        kind: schema.kind,
        source: vscode.workspace.asRelativePath(schema.source),
        fields: schema.fields,
      })),
      relations: inferSchemaRelations(scan.schemas),
      filesScanned: scan.filesScanned,
      usedFallback: scan.usedFallback,
      root,
      error: scan.error,
    };
  } catch (err) {
    return {
      tables: [],
      relations: [],
      filesScanned: 0,
      usedFallback: false,
      root,
      error: String(err),
    };
  }
}

/** Build the message payload the page consumes. Shared by the panel and the browser export. */
export function serializeGraph(
  graph: CallGraph,
  risk: RiskService,
  focusId?: string,
): {
  type: "graph";
  nodes: WireNode[];
  edges: { from: string; to: string }[];
  summary: string;
  focus?: string;
} {
  const nodes: WireNode[] = [];
  const edges: { from: string; to: string }[] = [];

  for (const node of graph.allNodes()) {
    const info = risk.riskFor(node);
    nodes.push({
      id: node.id,
      name: node.name,
      file: vscode.workspace.asRelativePath(node.file),
      startLine: node.startLine,
      endLine: node.endLine,
      fanIn: node.callers.size,
      fanOut: node.callees.size,
      score: info.score,
      tier: tierFor(info.score),
      risk: {
        fanIn: info.fanIn,
        coveragePct: info.coveragePct,
        coverageIsProxy: info.coverageIsProxy,
        churnCount: info.churnCount,
        busFactor: info.busFactor,
        authors: info.authors,
        lastChange: info.lastChange,
        commits: info.commits,
        testRefs: info.testRefs,
        gitResolved: info.gitResolved,
      },
    });
    for (const calleeId of node.callees) {
      edges.push({ from: node.id, to: calleeId });
    }
  }

  nodes.sort((a, b) => b.score - a.score);
  const coverage = risk.hasRealCoverage
    ? risk.coverageSource
    : "proxy coverage (no lcov.info)";
  const summary =
    `${nodes.length} functions · ${edges.length} edges · ${coverage}` +
    (risk.gitAvailable ? "" : " · no git history");

  return { type: "graph", nodes, edges, summary, focus: focusId };
}

/**
 * Write a self-contained snapshot of the graph to a temp file and open it in the
 * system browser - the same page, with room to breathe on a full screen.
 * It is a snapshot: the extension cannot push updates into a browser tab, and
 * "open in editor" is inert there, so the page hides that button in this mode.
 */
export async function openInBrowser(
  context: vscode.ExtensionContext,
  graph: CallGraph,
  risk: RiskService,
  focusId?: string,
): Promise<void> {
  if (graph.size === 0) {
    vscode.window.showWarningMessage("Blast Radius: nothing indexed yet, so there is no graph to open.");
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Blast Radius: preparing the browser snapshot" },
    async (progress) => {
      try {
        const graphPayload = serializeGraph(graph, risk, focusId);

        // A browser tab has no extension host to ask later, so everything the
        // tabs need is baked in now.
        progress.report({ message: "features and LLM documents" });
        const ctx = await llmContextFor(graph, risk);
        const docs: Record<string, string> = {};
        let total = 0;
        for (const feature of ctx.features?.features || []) {
          // Source is included, but once the snapshot gets large later documents
          // drop it so the page stays quick to load.
          const md = featureMarkdown(feature.key, { ...ctx, maxSourceLines: total > 4_000_000 ? 0 : 1200 });
          total += md.length;
          docs[feature.key] = md;
        }

        progress.report({ message: "database schemas" });
        const schema = await collectSchemas();

        progress.report({ message: "backups and command log" });
        const backups = GraphPanel.backups ? await GraphPanel.backups.snapshot() : null;

        const payload = {
          ...graphPayload,
          schema,
          backups,
          features: ctx.features,
          llm: { features: docs },
          protocol: PROTOCOL_VERSION,
          version: context.extension?.packageJSON?.version ?? "dev",
        };

        const template = fs.readFileSync(path.join(context.extensionPath, "media", "graph.html"), "utf8");
        const html = buildStandaloneHtml(template, payload, new Date().toLocaleString());

        progress.report({ message: "opening" });
        const page = await servePage(html);
        const opened = await vscode.env.openExternal(vscode.Uri.parse(page.url));
        if (!opened) {
          // Some setups (remote sessions, locked-down browsers) refuse to open
          // URLs. Leave the page served and hand over the address instead.
          const choice = await vscode.window.showWarningMessage(
            `Blast Radius: could not open a browser automatically. The snapshot is at ${page.url}`,
            "Copy URL",
          );
          if (choice === "Copy URL") {
            await vscode.env.clipboard.writeText(page.url);
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Blast Radius: could not open the browser snapshot - ${err}`);
      }
    },
  );
}

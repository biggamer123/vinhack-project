/**
 * Blast Radius - Stage 3: the full call graph as a Pokedex-styled webview.
 *
 * The page itself lives in media/graph.html (inline <style> + <script>, D3 from
 * cdnjs, no build step). Keeping it in its own file rather than a TypeScript
 * template literal avoids escaping every ${} the D3 code needs.
 */
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CallGraph } from "./graph";
import { RiskService, tierFor } from "./risk";
import { inferSchemaRelations, scanDatabaseSchemas } from "./schema";
import { PROTOCOL_VERSION } from "./protocol";
import { buildStandaloneHtml } from "./standalone";

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

  private onMessage(msg: { type: string; id?: string; file?: string; line?: number }): void {
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
    }
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
  const graphPayload = serializeGraph(graph, risk, focusId);
  // Bake the schemas in too: a browser tab has no extension host to ask later.
  const payload = {
    ...graphPayload,
    schema: await collectSchemas(),
    protocol: PROTOCOL_VERSION,
    version: context.extension?.packageJSON?.version ?? "dev",
  };
  if (payload.nodes.length === 0) {
    vscode.window.showWarningMessage(
      "Blast Radius: nothing indexed yet, so there is no graph to open.",
    );
    return;
  }

  const template = fs.readFileSync(
    path.join(context.extensionPath, "media", "graph.html"),
    "utf8",
  );
  const html = buildStandaloneHtml(
    template,
    payload,
    new Date().toLocaleString(),
  );

  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", async () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine a local port for the graph preview."));
          return;
        }

        const url = `http://127.0.0.1:${address.port}/blast-radius.html`;

        const requestStarted = new Promise<void>((requestResolve) => {
          server.once("request", () => requestResolve());
        });

        try {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          await Promise.race([
            requestStarted,
            new Promise<void>((timeoutResolve) => {
              setTimeout(timeoutResolve, 5000);
            }),
          ]);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  } finally {
    server.close();
  }
}

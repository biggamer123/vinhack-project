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
import { buildStandaloneHtml } from "./standalone";

interface WireNode {
  id: string;
  name: string;
  file: string;
  startLine: number;
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
  };
}

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private ready = false;
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

  private onMessage(msg: { type: string; id?: string }): void {
    if (msg.type === "ready") {
      this.ready = true;
      this.update();
      return;
    }
    if (msg.type === "reveal" && msg.id) {
      this.reveal(msg.id);
      return;
    }
    if (msg.type === "browser") {
      void openInBrowser(this.context, this.graph, this.risk);
    }
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

  /** Serialize the current graph + risk data and send it to the page. */
  update(): void {
    if (!this.ready) {
      return;
    }
    const payload = serializeGraph(this.graph, this.risk);
    this.panel.webview.postMessage({ ...payload, focus: this.focusId });
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

/** Build the message payload the page consumes. Shared by the panel and the browser export. */
export function serializeGraph(
  graph: CallGraph,
  risk: RiskService,
): {
  type: "graph";
  nodes: WireNode[];
  edges: { from: string; to: string }[];
  summary: string;
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

  return { type: "graph", nodes, edges, summary };
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
): Promise<void> {
  const payload = serializeGraph(graph, risk);
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blast-radius-"));
  const file = path.join(dir, "blast-radius.html");
  fs.writeFileSync(file, html);
  await vscode.env.openExternal(vscode.Uri.file(file));
}

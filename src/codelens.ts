/**
 * Blast Radius - CodeLens showing live risk + caller counts above every function.
 *
 * Reads straight from the in-memory graph and the risk cache, so a refresh after
 * an incremental re-index (or after git history lands) updates the numbers with
 * no document re-parse here.
 */
import * as vscode from "vscode";
import { CallGraph } from "./graph";
import { RiskService, tierFor } from "./risk";

const TIER_MARK: Record<string, string> = {
  unused: "$(trash)",
  low: "$(shield)",
  medium: "$(warning)",
  high: "$(flame)",
  critical: "$(flame)",
};

export class RiskCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChange.event;

  constructor(
    private readonly graph: CallGraph,
    private readonly risk: RiskService,
  ) {}

  /** Ask VS Code to re-request lenses (call after the graph or risk data changes). */
  refresh(): void {
    this.onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (
      !vscode.workspace
        .getConfiguration("blastradius")
        .get<boolean>("enableCodeLens", true)
    ) {
      return [];
    }

    const nodes = this.graph.nodesInFile(document.uri.fsPath);
    const lenses: vscode.CodeLens[] = [];

    for (const node of nodes) {
      if (node.startLine >= document.lineCount) {
        continue; // graph is momentarily behind the buffer; next refresh fixes it
      }
      const line = document.lineAt(node.startLine);
      const range = new vscode.Range(
        node.startLine,
        line.firstNonWhitespaceCharacterIndex,
        node.startLine,
        line.text.length,
      );

      const info = this.risk.riskFor(node);
      const mark = TIER_MARK[tierFor(info.score)] || "";

      // Primary lens: the score + breakdown, hover for the plain-language version.
      lenses.push(
        new vscode.CodeLens(range, {
          title: `${mark} ${this.risk.summaryLine(node)}`,
          tooltip: this.risk.tooltip(node).value,
          command: "blastradius.showGraph",
          arguments: [node.id],
        }),
      );

      // Secondary lens: jump to a caller.
      if (node.callers.size > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "callers…",
            command: "blastradius.showCallers",
            arguments: [node.id],
          }),
        );
      }
    }

    return lenses;
  }
}

/** Hover with the full breakdown, for anyone who does not click CodeLenses. */
export class RiskHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly graph: CallGraph,
    private readonly risk: RiskService,
  ) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const nodes = this.graph.nodesInFile(document.uri.fsPath);
    // Innermost enclosing function wins.
    let best = undefined as (typeof nodes)[number] | undefined;
    for (const node of nodes) {
      if (position.line >= node.startLine && position.line <= node.endLine) {
        if (!best || node.startLine > best.startLine) {
          best = node;
        }
      }
    }
    if (!best) {
      return undefined;
    }
    return new vscode.Hover(this.risk.tooltip(best));
  }
}

/**
 * Blast Radius - coverage input.
 *
 * Two clearly-separated sources, never conflated:
 *   1. REAL: coverage/lcov.info DA records -> a true hit percentage per line range.
 *   2. PROXY: no lcov file at all -> "is this function's name mentioned under a
 *      test directory?". This is a weak signal and is always labelled as such
 *      in the UI (coverageIsProxy).
 */
import * as path from "path";
import * as vscode from "vscode";
import { coverageForRange, LcovIndex, parseLcov } from "./lcov";
import { extractTestIdentifiers, TestReference } from "./test-refs";

const LCOV_CANDIDATES = [
  "coverage/lcov.info",
  "lcov.info",
  "coverage/lcov-report/lcov.info",
];

const TEST_GLOB = "**/{test,tests,__tests__,spec}/**/*.{js,jsx,mjs,cjs,ts,tsx}";
const TEST_FILE_GLOB = "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx}";
const EXCLUDE = "**/{node_modules,dist,build,out,.git,.next,vendor}/**";

export class CoverageProvider {
  /** absolute file path -> (1-based line -> hit count). Empty when no lcov exists. */
  private lcov: LcovIndex = new Map();
  /** function name -> test files mentioning it. Only built when lcov is absent. */
  private testMentions = new Map<string, string[]>();
  /** function name -> test cases that mention it. */
  private testRefs = new Map<string, TestReference[]>();
  private lcovPath: string | undefined;

  get hasRealCoverage(): boolean {
    return this.lcov.size > 0;
  }

  get sourceLabel(): string {
    return this.lcovPath
      ? vscode.workspace.asRelativePath(this.lcovPath)
      : "test/ name proxy";
  }

  /** (Re)load coverage inputs for a workspace root. */
  async load(root: string): Promise<void> {
    this.lcov.clear();
    this.testMentions.clear();
    this.lcovPath = undefined;

    for (const candidate of LCOV_CANDIDATES) {
      const full = path.join(root, candidate);
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(full));
        this.parseLcov(root, Buffer.from(bytes).toString("utf8"));
        this.lcovPath = full;
        break;
      } catch {
        // candidate absent - try the next one
      }
    }

    if (!this.hasRealCoverage) {
      await this.buildProxyIndex();
    }
  }

  /**
   * Percentage of the function's line range recorded as hit.
   * Returns null when we have no information at all about that range.
   */
  coverageFor(
    file: string,
    name: string,
    startLine: number,
    endLine: number,
  ): { pct: number | null; isProxy: boolean } {
    if (this.hasRealCoverage) {
      return {
        pct: coverageForRange(this.lcov, file, startLine, endLine),
        isProxy: false,
      };
    }

    // Proxy mode: presence of the name in a test file, nothing more.
    // 100/0 here means "likely covered" / "no mention" - NOT a measured
    // percentage. Callers must show it differently (coverageIsProxy).
    const mentioned = this.proxyMentions(name).length > 0;
    return { pct: mentioned ? 100 : 0, isProxy: true };
  }

  /** Proxy-only: is this function's name referenced anywhere under a test dir? */
  proxyMentions(name: string): string[] {
    return this.testMentions.get(name) || [];
  }

  relatedTests(name: string): TestReference[] {
    return this.testRefs.get(name) || [];
  }

  private parseLcov(root: string, text: string): void {
    this.lcov = parseLcov(root, text);
  }

  private async buildProxyIndex(): Promise<void> {
    const uris = [
      ...(await vscode.workspace.findFiles(TEST_GLOB, EXCLUDE)),
      ...(await vscode.workspace.findFiles(TEST_FILE_GLOB, EXCLUDE)),
    ];
    const seen = new Set<string>();
    for (const uri of uris) {
      if (seen.has(uri.fsPath)) {
        continue;
      }
      seen.add(uri.fsPath);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        const byName = extractTestIdentifiers(text);
        for (const [name, refs] of byName.entries()) {
          const list = this.testMentions.get(name) || [];
          if (!list.includes(uri.fsPath)) {
            list.push(uri.fsPath);
          }
          this.testMentions.set(name, list);

          const next = (this.testRefs.get(name) || []).slice();
          for (const ref of refs) {
            next.push({
              file: uri.fsPath,
              line: ref.line,
              name: ref.name,
            });
          }
          this.testRefs.set(name, next);
        }

        for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
          const name = match[0];
          if (this.testRefs.has(name)) {
            continue;
          }
          const list = this.testMentions.get(name);
          if (list) {
            if (!list.includes(uri.fsPath)) {
              list.push(uri.fsPath);
            }
          } else {
            this.testMentions.set(name, [uri.fsPath]);
          }
        }
      } catch {
        // unreadable test file - ignore
      }
    }
  }
}

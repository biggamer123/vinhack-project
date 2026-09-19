/**
 * Blast Radius - in-memory call graph.
 *
 * Stage 1 is deliberately 100% deterministic: everything here is derived from
 * tree-sitter parse results, never from an LLM.
 */

/** A single named function in the workspace. */
export interface FunctionNode {
  /** Stable key: "<absolute file path>:<function name>" (plus "#<line>" on collision). */
  id: string;
  /** Absolute fs path of the file the function is declared in. */
  file: string;
  /** Declared name (or the name it was assigned to). */
  name: string;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
  /**
   * How the function was written. A bare `function foo()` outranks a property
   * or variable of the same name when resolving a call, since `{ foo: () => foo(x) }`
   * almost always means the declaration, not itself.
   */
  kind: "declaration" | "binding";
  /** Exported from its module (export keyword, module.exports, or a capitalised Go name). */
  exported: boolean;
  /** Invoked by a framework, runtime or test runner: main, default exports, route handlers, tests. */
  entry: boolean;
  /** ids of functions that call this one. */
  callers: Set<string>;
  /** ids of functions this one calls. */
  callees: Set<string>;
}

/**
 * A raw, unresolved call site. We keep these per-file so that a single file
 * changing on save only requires re-parsing that file - edges for the whole
 * workspace are then cheaply recomputed from the full call-site table.
 */
export interface CallSite {
  /** id of the function the call appears inside. Null for top-level calls. */
  callerId: string | null;
  /** Callee identifier as written at the call site (`foo`, or `bar` in `a.bar()`). */
  calleeName: string;
  /** 0-based line of the call site. */
  line: number;
  /** Number of arguments passed (recorded now; used by Stage 4's mismatch detector). */
  argCount: number;
  /**
   * A use rather than a call: the function passed as a value (a callback, a
   * router registration, a JSX tag like <Card />). It is a dependency all the
   * same - if Card breaks, every page rendering it breaks.
   */
  use?: boolean;
}

/** What the indexer produces for one file. */
export interface FileIndex {
  nodes: FunctionNode[];
  callSites: CallSite[];
  /** How many times each identifier appears in the file. */
  refs: Record<string, number>;
}

/** Whether a function is in use; see computeRisk in ./score and usageStatus below. */
import type { UsageStatus } from "./score";
export type { UsageStatus };

export class CallGraph {
  /** id -> node */
  private nodes = new Map<string, FunctionNode>();
  /** absolute file path -> ids declared in that file */
  private byFile = new Map<string, Set<string>>();
  /** absolute file path -> call sites found in that file */
  private callSitesByFile = new Map<string, CallSite[]>();
  /** absolute file path -> identifier occurrence counts in that file */
  private refsByFile = new Map<string, Record<string, number>>();
  /** identifier -> occurrences across the workspace, rebuilt lazily */
  private refTotals: Map<string, number> | null = null;
  /** Bumped whenever anything changes, so cached scores know when to recompute. */
  revision = 0;
  /** function name -> ids sharing that name (for cross-file fallback resolution) */
  private byName = new Map<string, Set<string>>();

  get size(): number {
    return this.nodes.size;
  }

  get callSiteCount(): number {
    let n = 0;
    for (const sites of this.callSitesByFile.values()) {
      n += sites.length;
    }
    return n;
  }

  getNode(id: string): FunctionNode | undefined {
    return this.nodes.get(id);
  }

  allNodes(): FunctionNode[] {
    return [...this.nodes.values()];
  }

  /** Nodes declared in a file, sorted by start line. */
  nodesInFile(file: string): FunctionNode[] {
    const ids = this.byFile.get(file);
    if (!ids) {
      return [];
    }
    return [...ids]
      .map((id) => this.nodes.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.startLine - b.startLine);
  }

  /** Innermost function declared at a given 0-based line within a file. */
  nodeAtLine(file: string, line: number): FunctionNode | undefined {
    let best: FunctionNode | undefined;
    for (const node of this.nodesInFile(file)) {
      if (line >= node.startLine && line <= node.endLine) {
        if (!best || node.startLine > best.startLine) {
          best = node;
        }
      }
    }
    return best;
  }

  /** Replace everything known about one file. Does not rebuild edges - call resolveEdges(). */
  setFile(file: string, index: FileIndex): void {
    this.removeFile(file, { keepEdgesStale: true });

    const ids = new Set<string>();
    for (const node of index.nodes) {
      this.nodes.set(node.id, node);
      ids.add(node.id);
      let named = this.byName.get(node.name);
      if (!named) {
        named = new Set();
        this.byName.set(node.name, named);
      }
      named.add(node.id);
    }
    this.byFile.set(file, ids);
    this.callSitesByFile.set(file, index.callSites);
    this.refsByFile.set(file, index.refs || {});
    this.refTotals = null;
  }

  /** Forget a file entirely. */
  removeFile(file: string, opts: { keepEdgesStale?: boolean } = {}): void {
    const ids = this.byFile.get(file);
    if (ids) {
      for (const id of ids) {
        const node = this.nodes.get(id);
        if (node) {
          const named = this.byName.get(node.name);
          named?.delete(id);
          if (named && named.size === 0) {
            this.byName.delete(node.name);
          }
        }
        this.nodes.delete(id);
      }
    }
    this.byFile.delete(file);
    this.callSitesByFile.delete(file);
    this.refsByFile.delete(file);
    this.refTotals = null;
    if (!opts.keepEdgesStale) {
      this.resolveEdges();
    }
  }

  /**
   * Times a function's name is used anywhere in the workspace, not counting the
   * declarations themselves. Name-based and therefore conservative: a common name
   * used elsewhere keeps a function "in use", which is the safe direction for a
   * signal that suggests deleting code.
   */
  referenceCount(node: FunctionNode): number {
    if (!this.refTotals) {
      this.refTotals = new Map();
      for (const refs of this.refsByFile.values()) {
        for (const [name, count] of Object.entries(refs)) {
          this.refTotals.set(name, (this.refTotals.get(name) || 0) + count);
        }
      }
    }
    const total = this.refTotals.get(node.name) || 0;
    const declarations = this.byName.get(node.name)?.size || 0;
    return Math.max(0, total - declarations);
  }

  usageStatus(node: FunctionNode): UsageStatus {
    if (node.entry) {
      return "entry";
    }
    if (node.callers.size > 0 || this.referenceCount(node) > 0) {
      return "active";
    }
    return node.exported ? "exported-unused" : "unused";
  }

  /**
   * Functions that reach this one through calls, however indirectly - the real
   * blast radius. Capped, because impact is scored on a log scale that has long
   * saturated by then.
   */
  reachCount(id: string, cap = 256): number {
    const seen = new Set<string>();
    const queue = [...(this.nodes.get(id)?.callers || [])];
    while (queue.length && seen.size < cap) {
      const next = queue.shift() as string;
      if (next === id || seen.has(next)) {
        continue;
      }
      seen.add(next);
      for (const caller of this.nodes.get(next)?.callers || []) {
        if (!seen.has(caller)) {
          queue.push(caller);
        }
      }
    }
    return seen.size;
  }

  /**
   * Rebuild every caller/callee edge from the stored call sites.
   *
   * Resolution order for a callee name:
   *   1. a function with that name declared in the same file as the call site
   *   2. any function with that name anywhere in the graph (lowest id wins, so
   *      the result is stable across runs)
   * Unresolved names (library calls, built-ins, dynamic dispatch) are dropped.
   */
  resolveEdges(): void {
    this.revision++;
    for (const node of this.nodes.values()) {
      node.callers.clear();
      node.callees.clear();
    }

    for (const [file, sites] of this.callSitesByFile) {
      const localIds = this.byFile.get(file);
      for (const site of sites) {
        if (!site.callerId) {
          continue; // top-level call - no enclosing function to attribute it to
        }
        const caller = this.nodes.get(site.callerId);
        if (!caller) {
          continue;
        }
        const calleeId = this.resolveCallee(site.calleeName, localIds);
        if (!calleeId || calleeId === caller.id) {
          continue; // unresolved, or direct recursion (not a blast-radius edge)
        }
        const callee = this.nodes.get(calleeId)!;
        caller.callees.add(calleeId);
        callee.callers.add(caller.id);
      }
    }
  }

  private resolveCallee(
    name: string,
    localIds: Set<string> | undefined,
  ): string | undefined {
    const candidates = this.byName.get(name);
    if (!candidates || candidates.size === 0) {
      return undefined;
    }
    if (localIds) {
      const local = [...candidates].filter((id) => localIds.has(id));
      const declared = local.find(
        (id) => this.nodes.get(id)?.kind === "declaration",
      );
      if (declared) {
        return declared;
      }
      if (local.length > 0) {
        return local.sort()[0];
      }
    }
    const all = [...candidates];
    const declaredAnywhere = all
      .filter((id) => this.nodes.get(id)?.kind === "declaration")
      .sort()[0];
    return declaredAnywhere || all.sort()[0];
  }

  clear(): void {
    this.nodes.clear();
    this.byFile.clear();
    this.callSitesByFile.clear();
    this.refsByFile.clear();
    this.refTotals = null;
    this.byName.clear();
  }
}

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
}

/** What the indexer produces for one file. */
export interface FileIndex {
  nodes: FunctionNode[];
  callSites: CallSite[];
}

export class CallGraph {
  /** id -> node */
  private nodes = new Map<string, FunctionNode>();
  /** absolute file path -> ids declared in that file */
  private byFile = new Map<string, Set<string>>();
  /** absolute file path -> call sites found in that file */
  private callSitesByFile = new Map<string, CallSite[]>();
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
    if (!opts.keepEdgesStale) {
      this.resolveEdges();
    }
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
    this.byName.clear();
  }
}

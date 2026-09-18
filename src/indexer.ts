/**
 * Blast Radius - tree-sitter based extraction of named functions and call sites.
 *
 * Two passes over one parse tree:
 *   1. named function declarations/expressions  -> FunctionNode[]
 *   2. call_expression nodes                    -> CallSite[] (resolved later, in CallGraph)
 *
 * Anonymous callbacks (`arr.map(x => ...)`) are skipped for now: without a name
 * there is nothing to key the graph on.
 */
import * as path from "path";
import Parser from "web-tree-sitter";
import { CallSite, FileIndex, FunctionNode } from "./graph";

/** One grammar per dialect: JSX and type annotations need different parsers. */
type Dialect = "javascript" | "typescript" | "tsx" | "go";

const GRAMMAR_FILE: Record<Dialect, string> = {
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  go: "tree-sitter-go.wasm",
};

const EXT_DIALECT: Record<string, Dialect> = {
  ".js": "javascript",
  ".jsx": "javascript", // the JS grammar handles JSX
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
};

const parsers = new Map<Dialect, Parser>();
let parsersDir = "";

/** The dialect we would parse this file as, or undefined if unsupported. */
export function dialectFor(file: string): Dialect | undefined {
  return EXT_DIALECT[path.extname(file).toLowerCase()];
}

/** Load the wasm runtime and every bundled grammar from /parsers. */
export async function initParser(extensionPath: string): Promise<void> {
  if (parsers.size > 0) {
    return;
  }
  parsersDir = path.join(extensionPath, "parsers");
  await Parser.init({
    locateFile(fileName: string) {
      return path.join(parsersDir, fileName);
    },
  });

  for (const dialect of Object.keys(GRAMMAR_FILE) as Dialect[]) {
    try {
      const language = await Parser.Language.load(
        path.join(parsersDir, GRAMMAR_FILE[dialect]),
      );
      const p = new Parser();
      p.setLanguage(language);
      parsers.set(dialect, p);
    } catch (err) {
      // A missing grammar disables that dialect but must not break the others.
      console.error(
        `[blast-radius] could not load the ${dialect} grammar:`,
        err,
      );
    }
  }

  if (parsers.size === 0) {
    throw new Error(
      "no tree-sitter grammars could be loaded from " + parsersDir,
    );
  }
}

export function isParserReady(): boolean {
  return parsers.size > 0;
}

export function loadedDialects(): string[] {
  return [...parsers.keys()];
}

/** Node types that introduce a function body. */
const FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "arrow_function",
  "method_definition",
  // TypeScript
  "function_signature",
  "method_signature",
  "abstract_method_signature",
]);

/** Function forms that carry their own name, as opposed to being assigned one. */
const DECLARATION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "function_signature",
  "method_signature",
  "abstract_method_signature",
]);

/**
 * Derive a name for a function node from the context it is declared in.
 * Returns undefined for genuinely anonymous functions.
 */
function nameForFunction(node: Parser.SyntaxNode): string | undefined {
  // function foo() {} / class method foo() {}
  const own = node.childForFieldName("name");
  if (own && own.text) {
    return own.text;
  }

  const parent = node.parent;
  if (!parent) {
    return undefined;
  }

  switch (parent.type) {
    // const foo = () => {} / let foo = function () {}
    case "variable_declarator":
      return parent.childForFieldName("name")?.text || undefined;
    // foo = function () {} / module.exports.foo = () => {}
    case "assignment_expression": {
      const left = parent.childForFieldName("left");
      if (!left) {
        return undefined;
      }
      if (left.type === "member_expression") {
        return left.childForFieldName("property")?.text || undefined;
      }
      return left.text || undefined;
    }
    // { foo: function () {} }
    case "pair":
      return (
        parent.childForFieldName("key")?.text?.replace(/['"`]/g, "") ||
        undefined
      );
    // class field: foo = () => {}
    case "field_definition":
    case "public_field_definition":
      return parent.childForFieldName("property")?.text || undefined;
    default:
      return undefined;
  }
}

/** Callee name as written: `foo()` -> foo, `a.b.foo()` -> foo. */
function calleeName(call: Parser.SyntaxNode): string | undefined {
  const fn = call.childForFieldName("function");
  if (!fn) {
    return undefined;
  }
  if (fn.type === "identifier") {
    return fn.text;
  }
  if (fn.type === "member_expression" || fn.type === "selector_expression") {
    const property =
      fn.childForFieldName("property") ??
      fn.childForFieldName("field") ??
      fn.namedChildren[fn.namedChildren.length - 1];
    return property?.text || undefined;
  }
  return undefined; // IIFE, computed dispatch, etc. - not resolvable statically
}

function argCount(call: Parser.SyntaxNode): number {
  const args = call.childForFieldName("arguments");
  if (!args) {
    return 0;
  }
  return args.namedChildren.filter((c) => c.type !== "comment").length;
}

/**
 * Parse one file's source into nodes + call sites.
 * Never throws: unparseable files yield an empty index and a logged warning.
 */
export function indexSource(file: string, source: string): FileIndex {
  const nodes: FunctionNode[] = [];
  const callSites: CallSite[] = [];

  const dialect = dialectFor(file);
  const parser = dialect ? parsers.get(dialect) : undefined;
  if (!parser) {
    return { nodes, callSites };
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (err) {
    console.error(`[blast-radius] parse failed for ${file}:`, err);
    return { nodes, callSites };
  }

  try {
    const usedIds = new Set<string>();
    // Stack of enclosing named-function ids, so a call site knows its caller.
    const stack: string[] = [];

    const visit = (node: Parser.SyntaxNode) => {
      let pushed = false;

      if (FUNCTION_TYPES.has(node.type)) {
        const name = nameForFunction(node);
        if (name) {
          let id = `${file}:${name}`;
          if (usedIds.has(id)) {
            // Two same-named functions in one file (nested, or shadowed):
            // disambiguate by line so neither is silently dropped.
            id = `${id}#${node.startPosition.row + 1}`;
          }
          usedIds.add(id);
          nodes.push({
            id,
            file,
            name,
            kind: DECLARATION_TYPES.has(node.type) ? "declaration" : "binding",
            startLine: node.startPosition.row,
            endLine: node.endPosition.row,
            callers: new Set<string>(),
            callees: new Set<string>(),
          });
          stack.push(id);
          pushed = true;
        }
      } else if (node.type === "call_expression") {
        const callee = calleeName(node);
        if (callee) {
          callSites.push({
            callerId: stack.length ? stack[stack.length - 1] : null,
            calleeName: callee,
            line: node.startPosition.row,
            argCount: argCount(node),
          });
        }
      }

      for (const child of node.namedChildren) {
        visit(child);
      }

      if (pushed) {
        stack.pop();
      }
    };

    visit(tree.rootNode);
  } catch (err) {
    console.error(`[blast-radius] extraction failed for ${file}:`, err);
  } finally {
    tree.delete();
  }

  return { nodes, callSites };
}

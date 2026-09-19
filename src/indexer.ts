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
  // Go: `func (t *T) Name()` - without this every Go method, which is where most
  // handlers live, was missing from the graph.
  "method_declaration",
]);

/** Function forms that carry their own name, as opposed to being assigned one. */
const DECLARATION_TYPES = new Set([
  "function_declaration",
  "method_declaration",
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

/**
 * Identifier node types. Every occurrence of a function's name in one of these
 * - a call, a callback passed by name, a JSX tag, an export list, a router
 * registration like `r.Get("/", ctrl.List)` - counts as a reference. That is
 * what separates "nothing calls it directly" from "nothing uses it at all".
 */
const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "field_identifier",
]);

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|[\\/](__tests__|tests?)[\\/])/i;

/** Called by a runtime, framework or test runner rather than by code in the workspace. */
const JS_ENTRY_NAMES = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "generateMetadata", "generateStaticParams", "getServerSideProps", "getStaticProps", "getStaticPaths",
  "middleware", "loader", "action", "constructor", "render", "componentDidMount", "componentDidUpdate",
  "componentWillUnmount", "shouldComponentUpdate", "getDerivedStateFromProps", "toString", "toJSON", "valueOf",
]);
const GO_ENTRY_NAMES = new Set([
  "main", "init", "ServeHTTP", "String", "Error", "GoString", "Format", "MarshalJSON", "UnmarshalJSON",
  "MarshalText", "UnmarshalText", "Scan", "Value", "Len", "Less", "Swap", "Read", "Write", "Close", "Unwrap", "Is", "As",
]);

function exportInfo(node: Parser.SyntaxNode, name: string, dialect: string): { exported: boolean; defaultExport: boolean } {
  if (dialect === "go") {
    return { exported: /^[A-Z]/.test(name), defaultExport: false };
  }
  if (node.type === "method_definition") {
    // A method is reachable through any instance handed anywhere; only #private ones are truly internal.
    const key = node.childForFieldName("name");
    return { exported: !(key && key.type === "private_property_identifier"), defaultExport: false };
  }
  let cur: Parser.SyntaxNode | null = node;
  for (let depth = 0; cur && depth < 4; depth++, cur = cur.parent) {
    if (cur.type === "export_statement") {
      return { exported: true, defaultExport: /^export\s+default\b/.test(cur.text) };
    }
    if (cur.type === "assignment_expression") {
      const left = cur.childForFieldName("left")?.text || "";
      if (/^(module\.)?exports(\.|$)/.test(left)) {
        return { exported: true, defaultExport: left === "module.exports" };
      }
    }
  }
  return { exported: false, defaultExport: false };
}

/**
 * A function that is the value of an object property (`{ onSuccess: () => ... }`)
 * or is assigned onto another object (`reader.onload = () => ...`). Its name is
 * just a key: the object is handed to a library or the runtime, which calls it.
 * Nothing in the workspace ever mentions that name, so reference counting cannot
 * judge it - it must never be reported as unused.
 */
function isHeldCallback(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (parent.type === "pair") {
    return true;
  }
  if (parent.type === "assignment_expression") {
    const left = parent.childForFieldName("left");
    return !!left && left.type === "member_expression" && !/^(module\.)?exports(\.|$)/.test(left.text);
  }
  return false;
}

function isEntryPoint(name: string, file: string, dialect: string, defaultExport: boolean): boolean {
  if (defaultExport || TEST_FILE.test(file)) {
    return true;
  }
  if (dialect === "go") {
    return GO_ENTRY_NAMES.has(name) || /^(Test|Benchmark|Example|Fuzz)[A-Z_]?/.test(name);
  }
  return JS_ENTRY_NAMES.has(name);
}


/**
 * Whether an identifier is a function used as a value - passed as an argument,
 * given as an object value, rendered as a JSX tag, or set as a JSX attribute -
 * rather than, say, a variable being declared or a property being read.
 */
function isValueUse(node: Parser.SyntaxNode): boolean {
  let cur = node;
  let parent = node.parent;
  // obj.handler / t.ListAll: judge the whole member or selector expression
  if (parent && (parent.type === "member_expression" || parent.type === "selector_expression") && parent.childForFieldName(parent.type === "member_expression" ? "property" : "field")?.id === node.id) {
    cur = parent;
    parent = parent.parent;
  }
  if (!parent) {
    return false;
  }
  switch (parent.type) {
    case "arguments": // JS/TS call arguments
    case "argument_list": // Go call arguments
    case "jsx_expression": // onClick={handleSubmit}
      return true;
    case "jsx_opening_element":
    case "jsx_self_closing_element":
      return parent.childForFieldName("name")?.id === cur.id; // <Card />
    case "pair":
      return parent.childForFieldName("value")?.id === cur.id; // { mutationFn: save }
    case "keyed_element": // Go composite literal: Handler{Fn: handle}
    case "literal_element":
      return true;
    default:
      return cur.type === "shorthand_property_identifier"; // { save }
  }
}

const EXPORTS_TARGET = /^(module\.)?exports(\.|$)/;

export function indexSource(file: string, source: string): FileIndex {
  const nodes: FunctionNode[] = [];
  const callSites: CallSite[] = [];
  const refs: Record<string, number> = {};

  const dialect = dialectFor(file);
  const parser = dialect ? parsers.get(dialect) : undefined;
  if (!parser) {
    return { nodes, callSites, refs };
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (err) {
    console.error(`[blast-radius] parse failed for ${file}:`, err);
    return { nodes, callSites, refs };
  }

  // Generated code (sqlc, protobuf, GraphQL codegen...) is rewritten by its tool,
  // so its functions are never suggested for removal. Go's convention is a
  // "Code generated ... DO NOT EDIT." header; others use @generated.
  const generated = /Code generated .* DO NOT EDIT|@generated|auto-?generated/i.test(source.slice(0, 600));

  try {
    const usedIds = new Set<string>();
    // Stack of enclosing named-function ids, so a call site knows its caller.
    const stack: string[] = [];

    // Names listed in `module.exports = { a, b }` / `exports.a = a` are exports, not uses.
    // Only an object literal or a bare name is an export list; a function assigned
    // there (`exports.main = () => {...}`) is itself the export, and its body is code.
    const exportedNames = new Set<string>();
    const exportLists = new Set<number>();
    const visit = (node: Parser.SyntaxNode, inExports = false) => {
      let pushed = false;
      if (node.type === "assignment_expression" && EXPORTS_TARGET.test(node.childForFieldName("left")?.text || "")) {
        const right = node.childForFieldName("right");
        if (right && right.type === "identifier") {
          exportedNames.add(right.text);
          exportLists.add(right.id);
        } else if (right && right.type === "object") {
          exportLists.add(right.id);
          for (const entry of right.namedChildren) {
            if (entry.type === "shorthand_property_identifier") {
              exportedNames.add(entry.text);
            } else if (entry.type === "pair") {
              const value = entry.childForFieldName("value");
              if (value && value.type === "identifier") {
                exportedNames.add(value.text);
              }
            }
          }
        }
      }
      if (exportLists.has(node.id)) {
        inExports = true;
      }

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
          const exp = exportInfo(node, name, dialect || "");
          nodes.push({
            id,
            file,
            name,
            exported: exp.exported,
            entry: generated || isHeldCallback(node) || isEntryPoint(name, file, dialect || "", exp.defaultExport),
            kind: DECLARATION_TYPES.has(node.type) ? "declaration" : "binding",
            startLine: node.startPosition.row,
            endLine: node.endPosition.row,
            callers: new Set<string>(),
            callees: new Set<string>(),
          });
          stack.push(id);
          pushed = true;
        }
      } else if (IDENTIFIER_TYPES.has(node.type)) {
        if (!inExports) {
          refs[node.text] = (refs[node.text] || 0) + 1;
          if (stack.length && isValueUse(node)) {
            callSites.push({
              callerId: stack[stack.length - 1],
              calleeName: node.text,
              line: node.startPosition.row,
              argCount: -1,
              use: true,
            });
          }
        }
      }
      if (node.type === "call_expression") {
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
        visit(child, inExports);
      }

      if (pushed) {
        stack.pop();
      }
    };

    visit(tree.rootNode);
    for (const n of nodes) {
      if (exportedNames.has(n.name)) {
        n.exported = true;
      }
    }
  } catch (err) {
    console.error(`[blast-radius] extraction failed for ${file}:`, err);
  } finally {
    tree.delete();
  }

  return { nodes, callSites, refs };
}

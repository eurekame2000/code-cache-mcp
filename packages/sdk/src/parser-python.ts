import Parser from "web-tree-sitter";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import type { LanguageParser, ParseResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = resolve(__dirname, "../../wasm");

let _parser: Parser | null = null;
let _language: Parser.Language | null = null;

async function getParser(): Promise<Parser> {
  if (_parser) return _parser;
  await Parser.init({ locateFile: (name: string) => join(WASM_DIR, name) });
  _parser = new Parser();
  _language = await Parser.Language.load(join(WASM_DIR, "tree-sitter-python.wasm"));
  _parser.setLanguage(_language);
  return _parser;
}

function sliceSource(source: string, node: Parser.SyntaxNode): string {
  return source.slice(node.startIndex, node.endIndex);
}

function buildPySignature(node: Parser.SyntaxNode, name: string, source: string): string {
  const params = node.childForFieldName("parameters");
  const ret = node.childForFieldName("return_type");
  const p = params ? sliceSource(source, params) : "()";
  const r = ret ? `: ${sliceSource(source, ret)}` : "";
  return `${name}${p}${r}`.replace(/\s+/g, " ");
}

function extractCallsFromBody(
  bodyNode: Parser.SyntaxNode,
  source: string
): Array<{ callee_name: string; call_line: number }> {
  const calls: Array<{ callee_name: string; call_line: number }> = [];

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "call") {
      const fnNode = node.childForFieldName("function");
      if (fnNode) {
        // obj.method() → use attribute name; foo() → use identifier
        const nameNode = fnNode.type === "attribute"
          ? fnNode.childForFieldName("attribute")
          : fnNode.type === "identifier" ? fnNode : null;
        if (nameNode) {
          calls.push({ callee_name: sliceSource(source, nameNode), call_line: nameNode.startPosition.row + 1 });
        }
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(bodyNode);
  return calls;
}

function visitNode(
  node: Parser.SyntaxNode,
  source: string,
  filePath: string,
  result: ParseResult,
  parentIdx?: number
) {
  if (node.type === "class_definition") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const idx = result.symbols.length;
    result.symbols.push({
      file_path: filePath, language: "python", symbol_name: name,
      symbol_kind: "class", start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      parent_id: parentIdx,
    });

    // Extract base classes: class Foo(Bar, Baz):
    const args = node.childForFieldName("superclasses");
    if (args) {
      for (const child of args.children) {
        if (child.type === "identifier") {
          result.relationships.push({
            child_symbol_id: idx, parent_name: sliceSource(source, child),
            relationship: "extends",
          } as any);
        }
      }
    }

    for (const child of node.children) visitNode(child, source, filePath, result, idx);
    return;
  }

  if (node.type === "function_definition") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const kind = parentIdx !== undefined ? "method" : "function";
    const symIdx = result.symbols.length;
    result.symbols.push({
      file_path: filePath, language: "python", symbol_name: name,
      symbol_kind: kind as any, start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      parent_id: parentIdx,
      signature: buildPySignature(node, name, source),
    });

    const bodyNode = node.childForFieldName("body");
    if (bodyNode) {
      const calls = extractCallsFromBody(bodyNode, source);
      for (const call of calls) {
        result.callEdges.push({ caller_id: symIdx, callee_name: call.callee_name, call_line: call.call_line } as any);
      }
    }
    return;
  }

  for (const child of node.children) visitNode(child, source, filePath, result, parentIdx);
}

export class PythonParser implements LanguageParser {
  private initialized = false;

  async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await getParser();
      this.initialized = true;
    }
  }

  parse(source: string, filePath: string): ParseResult {
    const parser = _parser!;
    const tree = parser.parse(source)!;
    const result: ParseResult = { symbols: [], relationships: [], callEdges: [] };
    visitNode(tree.rootNode, source, filePath, result, undefined);
    return result;
  }
}

export async function createPythonParser(): Promise<PythonParser> {
  const p = new PythonParser();
  await p.ensureInit();
  return p;
}

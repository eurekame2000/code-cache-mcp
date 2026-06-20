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
  _language = await Parser.Language.load(join(WASM_DIR, "tree-sitter-rust.wasm"));
  _parser.setLanguage(_language);
  return _parser;
}

function sliceSource(source: string, node: Parser.SyntaxNode): string {
  return source.slice(node.startIndex, node.endIndex);
}

function extractCallsFromBody(
  bodyNode: Parser.SyntaxNode,
  source: string
): Array<{ callee_name: string; call_line: number }> {
  const calls: Array<{ callee_name: string; call_line: number }> = [];

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode) {
        const nameNode =
          fnNode.type === "field_expression"
            ? fnNode.childForFieldName("field")
            : fnNode.type === "identifier"
            ? fnNode
            : null;
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
  if (node.type === "struct_item") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const symIdx = result.symbols.length;
    result.symbols.push({
      file_path: filePath, language: "rust", symbol_name: name,
      symbol_kind: "class", start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1, parent_id: parentIdx,
    });
    const fieldList = node.childForFieldName("body");
    if (fieldList) {
      for (const child of fieldList.children) {
        if (child.type === "field_declaration") {
          const fieldName = child.childForFieldName("name");
          if (fieldName) {
            result.symbols.push({
              file_path: filePath, language: "rust",
              symbol_name: sliceSource(source, fieldName),
              symbol_kind: "field", start_line: child.startPosition.row + 1,
              end_line: child.endPosition.row + 1, parent_id: symIdx,
            });
          }
        }
      }
    }
    return;
  }

  if (node.type === "enum_item") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    result.symbols.push({
      file_path: filePath, language: "rust", symbol_name: name,
      symbol_kind: "enum", start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1, parent_id: parentIdx,
    });
    return;
  }

  if (node.type === "trait_item") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const symIdx = result.symbols.length;
    result.symbols.push({
      file_path: filePath, language: "rust", symbol_name: name,
      symbol_kind: "interface", start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1, parent_id: parentIdx,
    });
    for (const child of node.children) visitNode(child, source, filePath, result, symIdx);
    return;
  }

  if (node.type === "impl_item") {
    for (const child of node.children) visitNode(child, source, filePath, result, parentIdx);
    return;
  }

  if (node.type === "function_item") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const kind = parentIdx !== undefined ? "method" : "function";
    const symIdx = result.symbols.length;
    result.symbols.push({
      file_path: filePath, language: "rust", symbol_name: name,
      symbol_kind: kind as any, start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1, parent_id: parentIdx,
    });
    const bodyNode = node.childForFieldName("body");
    if (bodyNode) {
      for (const call of extractCallsFromBody(bodyNode, source)) {
        result.callEdges.push({ caller_id: symIdx, callee_name: call.callee_name, call_line: call.call_line } as any);
      }
    }
    return;
  }

  for (const child of node.children) visitNode(child, source, filePath, result, parentIdx);
}

export class RustParser implements LanguageParser {
  private initialized = false;

  async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await getParser();
      this.initialized = true;
    }
  }

  parse(source: string, filePath: string): ParseResult {
    const tree = _parser!.parse(source)!;
    const result: ParseResult = { symbols: [], relationships: [], callEdges: [] };
    visitNode(tree.rootNode, source, filePath, result, undefined);
    return result;
  }
}

export async function createRustParser(): Promise<RustParser> {
  const p = new RustParser();
  await p.ensureInit();
  return p;
}

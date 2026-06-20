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
  _language = await Parser.Language.load(join(WASM_DIR, "tree-sitter-go.wasm"));
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
        // obj.Method() → selector_expression, take "field" child
        // foo() → identifier
        const nameNode = fnNode.type === "selector_expression"
          ? fnNode.childForFieldName("field")
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
  // Top-level function
  if (node.type === "function_declaration") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const symIdx = result.symbols.length;
    result.symbols.push({
      file_path: filePath, language: "go", symbol_name: name,
      symbol_kind: "function", start_line: node.startPosition.row + 1,
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

  // Method with receiver: func (r Receiver) Name() {}
  if (node.type === "method_declaration") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const symIdx = result.symbols.length;
    result.symbols.push({
      file_path: filePath, language: "go", symbol_name: name,
      symbol_kind: "method", start_line: node.startPosition.row + 1,
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

  // type Foo struct { ... } / type Bar interface { ... }
  if (node.type === "type_declaration") {
    for (const child of node.children) {
      if (child.type === "type_spec") {
        const nameNode = child.childForFieldName("name");
        const typeNode = child.childForFieldName("type");
        if (!nameNode || !typeNode) continue;
        const name = sliceSource(source, nameNode);
        const kind = typeNode.type === "interface_type" ? "interface" : "class";
        const symIdx = result.symbols.length;
        result.symbols.push({
          file_path: filePath, language: "go", symbol_name: name,
          symbol_kind: kind as any, start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1, parent_id: parentIdx,
        });
        // Extract struct fields
        if (typeNode.type === "struct_type") {
          for (const fieldList of typeNode.children) {
            if (fieldList.type !== "field_declaration_list") continue;
            for (const field of fieldList.children) {
              if (field.type !== "field_declaration") continue;
              // first identifier child is the field name
              const fieldName = field.children.find(c => c.type === "field_identifier" || c.type === "identifier");
              if (fieldName) {
                result.symbols.push({
                  file_path: filePath, language: "go",
                  symbol_name: sliceSource(source, fieldName),
                  symbol_kind: "field", start_line: field.startPosition.row + 1,
                  end_line: field.endPosition.row + 1, parent_id: symIdx,
                });
              }
            }
          }
        }
      }
    }
    return;
  }

  for (const child of node.children) visitNode(child, source, filePath, result, parentIdx);
}

export class GoParser implements LanguageParser {
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

export async function createGoParser(): Promise<GoParser> {
  const p = new GoParser();
  await p.ensureInit();
  return p;
}

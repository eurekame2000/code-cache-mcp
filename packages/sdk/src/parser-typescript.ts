import Parser from "web-tree-sitter";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import type { LanguageParser, ParseResult, SymbolKind } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = resolve(__dirname, "../../wasm");

let _parser: Parser | null = null;
let _language: Parser.Language | null = null;

async function getParser(): Promise<Parser> {
  if (_parser) return _parser;
  await Parser.init({ locateFile: (name: string) => join(WASM_DIR, name) });
  _parser = new Parser();
  _language = await Parser.Language.load(join(WASM_DIR, "tree-sitter-typescript.wasm"));
  _parser.setLanguage(_language);
  return _parser;
}

function sliceSource(source: string, node: Parser.SyntaxNode): string {
  return source.slice(node.startIndex, node.endIndex);
}

function visitNode(
  node: Parser.SyntaxNode,
  source: string,
  filePath: string,
  result: ParseResult,
  parentIdx?: number
) {
  switch (node.type) {
    case "class_declaration":
    case "abstract_class_declaration": {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
      const idx = result.symbols.length;
      result.symbols.push({
        file_path: filePath, language: "typescript", symbol_name: name,
        symbol_kind: "class", start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        parent_id: parentIdx,
      });

      // extends / implements
      const heritage = node.children.filter(c => c.type === "class_heritage");
      for (const h of heritage) {
        for (const clause of h.children) {
          if (clause.type === "extends_clause") {
            for (const t of clause.children) {
              if (t.type === "identifier" || t.type === "type_identifier") {
                result.relationships.push({ child_symbol_id: idx, parent_name: sliceSource(source, t), relationship: "extends" } as any);
              }
            }
          } else if (clause.type === "implements_clause") {
            for (const t of clause.children) {
              if (t.type === "type_identifier") {
                result.relationships.push({ child_symbol_id: idx, parent_name: sliceSource(source, t), relationship: "implements" } as any);
              }
            }
          }
        }
      }
      for (const child of node.children) visitNode(child, source, filePath, result, idx);
      return;
    }

    case "interface_declaration": {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
      const idx = result.symbols.length;
      result.symbols.push({
        file_path: filePath, language: "typescript", symbol_name: name,
        symbol_kind: "interface", start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        parent_id: parentIdx,
      });
      for (const child of node.children) visitNode(child, source, filePath, result, idx);
      return;
    }

    case "method_definition":
    case "function_declaration":
    case "generator_function_declaration": {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
      const kind: SymbolKind = node.type === "method_definition" ? "method" : "function";
      result.symbols.push({
        file_path: filePath, language: "typescript", symbol_name: name,
        symbol_kind: kind, start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        parent_id: parentIdx,
      });
      return;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      // const Foo = () => {} or const Foo = function() {}
      for (const decl of node.children) {
        if (decl.type === "variable_declarator") {
          const nameNode = decl.childForFieldName("name");
          const valueNode = decl.childForFieldName("value");
          if (nameNode && valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function")) {
            result.symbols.push({
              file_path: filePath, language: "typescript",
              symbol_name: sliceSource(source, nameNode),
              symbol_kind: "function", start_line: node.startPosition.row + 1,
              end_line: node.endPosition.row + 1,
              parent_id: parentIdx,
            });
          }
        }
      }
      break;
    }

    case "public_field_definition":
    case "property_signature": {
      const nameNode = node.childForFieldName("name");
      if (nameNode && parentIdx !== undefined) {
        result.symbols.push({
          file_path: filePath, language: "typescript",
          symbol_name: sliceSource(source, nameNode),
          symbol_kind: "field", start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          parent_id: parentIdx,
        });
      }
      return;
    }
  }

  for (const child of node.children) visitNode(child, source, filePath, result, parentIdx);
}

export class TypeScriptParser implements LanguageParser {
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

export async function createTypeScriptParser(): Promise<TypeScriptParser> {
  const p = new TypeScriptParser();
  await p.ensureInit();
  return p;
}

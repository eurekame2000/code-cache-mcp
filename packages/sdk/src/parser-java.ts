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
  _language = await Parser.Language.load(join(WASM_DIR, "tree-sitter-java.wasm"));
  _parser.setLanguage(_language);
  return _parser;
}

function sliceSource(source: string, node: Parser.SyntaxNode): string {
  return source.slice(node.startIndex, node.endIndex);
}

function extractRelationships(
  classNode: Parser.SyntaxNode,
  source: string
): Array<{ parent_name: string; relationship: "extends" | "implements" }> {
  const rels: Array<{ parent_name: string; relationship: "extends" | "implements" }> = [];

  const superclass = classNode.childForFieldName("superclass");
  if (superclass) {
    // 'superclass' field contains the type_type node, get the type name
    for (const child of superclass.children) {
      if (child.type === "type_identifier") {
        rels.push({ parent_name: sliceSource(source, child), relationship: "extends" });
      }
    }
    if (superclass.type === "type_identifier") {
      rels.push({ parent_name: sliceSource(source, superclass), relationship: "extends" });
    }
  }

  const interfaces = classNode.childForFieldName("interfaces");
  if (interfaces) {
    for (const child of interfaces.children) {
      if (child.type === "type_identifier") {
        rels.push({ parent_name: sliceSource(source, child), relationship: "implements" });
      } else if (child.type === "type_list") {
        for (const t of child.children) {
          if (t.type === "type_identifier") {
            rels.push({ parent_name: sliceSource(source, t), relationship: "implements" });
          }
        }
      }
    }
  }

  // enum implements
  const enumInterfaces = classNode.childForFieldName("implements");
  if (enumInterfaces) {
    for (const child of enumInterfaces.children) {
      if (child.type === "type_identifier") {
        rels.push({ parent_name: sliceSource(source, child), relationship: "implements" });
      }
    }
  }

  return rels;
}

function extractCallsFromBody(
  bodyNode: Parser.SyntaxNode,
  source: string
): Array<{ callee_name: string; call_line: number }> {
  const calls: Array<{ callee_name: string; call_line: number }> = [];

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "method_invocation") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        calls.push({
          callee_name: sliceSource(source, nameNode),
          call_line: nameNode.startPosition.row + 1,
        });
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(bodyNode);
  return calls;
}

function visitBody(
  bodyNode: Parser.SyntaxNode,
  source: string,
  filePath: string,
  fileHash: string,
  result: ParseResult,
  parentSymbolIndex: number | undefined,
  parentSymbolKind: SymbolKind
) {
  for (const child of bodyNode.children) {
    if (child.type === "method_declaration" || child.type === "constructor_declaration") {
      const nameNode = child.childForFieldName("name");
      const name = nameNode ? sliceSource(source, nameNode) : "<unknown>";
      const kind: SymbolKind = child.type === "constructor_declaration" ? "constructor" : "method";
      const symIdx = result.symbols.length;

      result.symbols.push({
        file_path: filePath,
        language: "java",
        symbol_name: name,
        symbol_kind: kind,
        start_line: child.startPosition.row + 1,
        end_line: child.endPosition.row + 1,
        parent_id: parentSymbolIndex,
      });

      // Extract method calls from body
      const methodBody = child.childForFieldName("body");
      if (methodBody) {
        const calls = extractCallsFromBody(methodBody, source);
        for (const call of calls) {
          result.callEdges.push({
            // caller_id resolved in code-cache.ts after symbols inserted
            caller_id: symIdx,
            callee_name: call.callee_name,
            call_line: call.call_line,
          } as any);
        }
      }
    } else if (child.type === "field_declaration") {
      for (const c of child.children) {
        if (c.type === "variable_declarator") {
          const vn = c.childForFieldName("name");
          if (vn) {
            result.symbols.push({
              file_path: filePath,
              language: "java",
              symbol_name: sliceSource(source, vn),
              symbol_kind: "field",
              start_line: vn.startPosition.row + 1,
              end_line: child.endPosition.row + 1,
              parent_id: parentSymbolIndex,
            });
          }
        }
      }
    }
  }
}

function visitNode(
  node: Parser.SyntaxNode,
  source: string,
  filePath: string,
  fileHash: string,
  result: ParseResult
) {
  const typeKinds: Record<string, SymbolKind> = {
    class_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
    record_declaration: "record",
    annotation_type_declaration: "interface",
  };

  if (typeKinds[node.type]) {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? sliceSource(source, nameNode) : "<anonymous>";
    const kind = typeKinds[node.type];
    const classSymIdx = result.symbols.length;

    result.symbols.push({
      file_path: filePath,
      language: "java",
      symbol_name: name,
      symbol_kind: kind,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      parent_id: undefined,
    });

    // Extract class relationships
    const rels = extractRelationships(node, source);
    for (const rel of rels) {
      result.relationships.push({
        child_symbol_id: classSymIdx,
        parent_name: rel.parent_name,
        relationship: rel.relationship,
      } as any);
    }

    // Visit body for methods/fields
    const body = node.childForFieldName("body");
    if (body) {
      visitBody(body, source, filePath, fileHash, result, classSymIdx, kind);
    }
  }

  for (const child of node.children) visitNode(child, source, filePath, fileHash, result);
}

export class JavaParser implements LanguageParser {
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
    visitNode(tree.rootNode, source, filePath, "", result);
    return result;
  }
}

export async function createJavaParser(): Promise<JavaParser> {
  const p = new JavaParser();
  await p.ensureInit();
  return p;
}

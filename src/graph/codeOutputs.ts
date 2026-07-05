import { parse } from "@babel/parser";
import type * as t from "@babel/types";

function collectPatternNames(pattern: t.VariableDeclarator["id"]): string[] {
  if (pattern.type === "Identifier") {
    return [pattern.name];
  }

  return [];
}

export function codeOutputs(code: string): string[] {
  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration") {
      continue;
    }

    for (const declaration of statement.declarations) {
      names.push(...collectPatternNames(declaration.id));
    }
  }

  return Array.from(new Set(names));
}

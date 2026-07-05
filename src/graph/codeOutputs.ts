import { parse } from "@babel/parser";
import type * as t from "@babel/types";

function collectPatternNames(pattern: t.VariableDeclarator["id"]): string[] {
  if (pattern.type === "Identifier") {
    return [pattern.name];
  }

  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => {
      if (property.type === "ObjectProperty") {
        return collectPatternNames(property.value as t.VariableDeclarator["id"]);
      }

      if (property.type === "RestElement") {
        return collectPatternNames(property.argument as t.VariableDeclarator["id"]);
      }

      return [];
    });
  }

  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) =>
      element ? collectPatternNames(element as t.VariableDeclarator["id"]) : []
    );
  }

  if (pattern.type === "AssignmentPattern") {
    return collectPatternNames(pattern.left as t.VariableDeclarator["id"]);
  }

  if (pattern.type === "RestElement") {
    return collectPatternNames(pattern.argument as t.VariableDeclarator["id"]);
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

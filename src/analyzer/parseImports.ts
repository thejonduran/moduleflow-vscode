import { parse } from "@babel/parser";
import * as t from "@babel/types";

export type NamedImport = {
  modulePath: string;
  names: Array<{
    imported: string;
    local: string;
  }>;
};

export function parseNamedImports(source: string): NamedImport[] {
  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"]
    });
  } catch {
    return [];
  }

  return ast.program.body.flatMap((statement) => {
    if (!t.isImportDeclaration(statement)) {
      return [];
    }

    const names = statement.specifiers.flatMap((specifier) => {
      if (!t.isImportSpecifier(specifier)) {
        return [];
      }

      return [
        {
          imported: t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value,
          local: specifier.local.name
        }
      ];
    });

    return names.length > 0
      ? [
          {
            modulePath: statement.source.value,
            names
          }
        ]
      : [];
  });
}

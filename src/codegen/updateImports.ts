import { ImportedToolModule } from "../types";

function importLine(toolModule: ImportedToolModule): string {
  const names = toolModule.exports.map((item) => item.name).sort();
  return `import { ${names.join(", ")} } from "${toolModule.modulePath}";`;
}

export function upsertImports(source: string, modules: ImportedToolModule[]): string {
  const lines = source.split(/\r?\n/);
  const existingImportPaths = new Set<string>();
  const importPattern = /^\s*import\s+\{[^}]+\}\s+from\s+["']([^"']+)["'];?\s*$/;

  for (const line of lines) {
    const match = importPattern.exec(line);
    if (match) {
      existingImportPaths.add(match[1]);
    }
  }

  const newLines = modules
    .filter((item) => !existingImportPaths.has(item.modulePath))
    .map(importLine);

  if (newLines.length === 0) {
    return source;
  }

  const lastImportIndex = lines.reduce((last, line, index) => {
    return /^\s*import\b/.test(line) ? index : last;
  }, -1);

  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, ...newLines);
    return lines.join("\n");
  }

  return `${newLines.join("\n")}\n\n${source}`;
}

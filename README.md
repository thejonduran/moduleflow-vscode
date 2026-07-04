# ModuleFlow

ModuleFlow is a VS Code extension prototype for visually composing JavaScript modules.

The guiding rule is simple: the `.js` file is the source of truth. The canvas is another way to edit that file.

## MVP behavior

- Right-click a `.js` file and choose `ModuleFlow: Open Current File`.
- Import local JavaScript modules as tool sources.
- Imported module exports become draggable node definitions.
- Functions become call nodes.
- Classes become instance nodes, with their methods exposed as method-call nodes.
- The current file is updated with imports and a controlled ModuleFlow region.

## Current prototype scope

This first scaffold intentionally supports a small JavaScript subset:

- ESM named exports.
- `export function name(...)`.
- `export async function name(...)`.
- `export class Name { constructor(...); method(...) {} }`.
- `export const name = (...) => ...`.
- Composition code inside:

```js
// @moduleflow:start
// @moduleflow:end
```

The analyzer is dependency-light for now. A production version should replace it with an AST-backed parser/generator such as Recast plus Babel parser.

## Try the sample

Open `sample/main.js`, run `ModuleFlow: Open Current File`, then use `ModuleFlow: Import Tools` and select `apiClient.js` and `utils.js`.

# ModuleFlow

ModuleFlow is a VS Code extension prototype for visually composing JavaScript module logic.

The `.js` file remains the source of truth. ModuleFlow gives you a canvas for editing a controlled `@moduleflow:start` / `@moduleflow:end` region inside that file, while keeping the generated JavaScript readable.

ModuleFlow can import local JavaScript functions, classes, and methods as draggable tools. Nodes are connected with data edges for values and flow edges for execution order. Complete input-to-return flows generate exported JavaScript functions; disconnected nodes remain canvas-only.

This project is currently intended for development and personal use, not marketplace distribution.

## Development Setup

Install dependencies:

```bash
npm install
```

Build the extension:

```bash
npm run compile
```

Run tests:

```bash
npm test
```

Preview the webview outside VS Code:

```bash
npm run preview:webview
```

## Run Locally In VS Code

Open this project in VS Code.

Press `F5` to launch an Extension Development Host.

In the Extension Development Host:

1. Open a JavaScript file.
2. Run `ModuleFlow: Open Current File`.
3. Use `ModuleFlow: Import Tools` to import local JavaScript files as node tools.

## Install For Personal Use

Package the extension as a `.vsix` file:

```bash
npm install
npm run compile
npx vsce package
```

Install the generated `.vsix` in VS Code:

```bash
code --install-extension moduleflow-vscode-<version>.vsix
```

You can copy the `.vsix` file to another machine and install it there the same way.

## Notes

ModuleFlow only manages code inside the ModuleFlow region:

```js
// @moduleflow:start
// @moduleflow:end
```

Code outside that region should be preserved.

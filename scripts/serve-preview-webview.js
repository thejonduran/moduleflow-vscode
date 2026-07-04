const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "media");
const port = Number(process.env.PORT || 41737);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  const pathname = url.pathname === "/" ? "/preview-webview.html" : url.pathname;
  const filepath = path.resolve(root, `.${pathname}`);

  if (!filepath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filepath, (error, body) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filepath)] || "application/octet-stream"
    });
    response.end(body);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ModuleFlow preview server: http://127.0.0.1:${port}/preview-webview.html`);
});

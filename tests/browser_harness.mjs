// Full application with an in-memory API. It cannot connect to Supabase or send email.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { context } = require("esbuild");
const root = fileURLToPath(new URL("../frontend/", import.meta.url));
const compiler = await context({
  entryPoints: [root + "src/main.jsx"],
  bundle: true,
  write: false,
  jsx: "automatic",
  outdir: "out",
  define: {
    "import.meta.env.PROD": "false",
    "import.meta.env.BASE_URL": JSON.stringify("/uro-daily-pick/"),
    "import.meta.env.VITE_EMAIL_AUTH_READY": JSON.stringify("false"),
    "import.meta.env.VITE_EMAIL_DELIVERY_READY": JSON.stringify("false"),
    "import.meta.env.VITE_GOOGLE_CLIENT_ID": JSON.stringify(""),
    "import.meta.env.VITE_FULLTEXT_ORIGIN": JSON.stringify(
      "https://articles.example.test",
    ),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [
    {
      name: "isolated-api",
      setup(build) {
        build.onResolve({ filter: /\/supabase(?:\.js)?$/ }, () => ({
          path: fileURLToPath(
            new URL("./fixtures/browser_api.js", import.meta.url),
          ),
        }));
      },
    },
  ],
});
const cssFiles = (await readdir(root + "dist/assets")).filter((f) =>
  f.endsWith(".css"),
);
const css = (
  await Promise.all(
    cssFiles.map((f) => readFile(root + "dist/assets/" + f, "utf8")),
  )
).join("\n");
const server = createServer(async (req, res) => {
  if (req.url === "/fixture.js") {
    const result = await compiler.rebuild();
    const js = result.outputFiles.find((f) => f.path.endsWith(".js")).contents;
    res.setHeader("Content-Type", "text/javascript");
    res.end(js);
  } else if (req.url === "/fixture.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else if (req.url.endsWith(".svg")) {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Uro Daily Pick · isolated test</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    );
  }
});
server.listen(3101, "127.0.0.1", () =>
  console.log("Isolated application: http://127.0.0.1:3101/uro-daily-pick/ PID " + process.pid),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));

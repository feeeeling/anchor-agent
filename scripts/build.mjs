import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
};
const builds = [
  {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    format: "cjs",
    external: ["vscode"],
  },
  {
    ...shared,
    entryPoints: ["src/mcp-server.ts"],
    outfile: "dist/mcp-server.cjs",
    format: "cjs",
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((item) => item.watch()));
  console.log("Watching Anchor Agent sources…");
} else {
  await Promise.all(builds.map((options) => build(options)));
}

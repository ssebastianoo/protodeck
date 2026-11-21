// Dev loop: builds protodeck, serves a dummy project from ./playground, and
// rebuilds + restarts the server whenever src/, ui/, skill/ or templates/ change.
// Usage: npm run dev [-- <protodeck options>]   e.g. npm run dev -- --agent none
import { spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const playground = join(root, "playground");
const cli = join(root, "dist", "cli.js");
const extraArgs = process.argv.slice(2);

function build() {
  const r = spawnSync("npm run build --silent", { cwd: root, stdio: "inherit", shell: true });
  return r.status === 0;
}

if (!build()) process.exit(1);

if (!existsSync(join(playground, "protodeck"))) {
  console.log("dev: creating playground/ (gitignored dummy project)");
  spawnSync("node", [cli, "init"], { cwd: playground, stdio: "inherit" });
}

let child;
function start() {
  child = spawn("node", [cli, ...extraArgs], { cwd: playground, stdio: "inherit" });
}
function stop() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

let timer;
let busy = false;
let again = false;
async function rebuild() {
  if (busy) return void (again = true);
  busy = true;
  console.log("\ndev: change detected, rebuilding...");
  if (build()) {
    await stop();
    start();
  } else {
    console.log("dev: build failed, keeping the running server. Fix the error and save again.");
  }
  busy = false;
  if (again) {
    again = false;
    rebuild();
  }
}

for (const dir of ["src", "ui", "skill", "templates"]) {
  watch(join(root, dir), { recursive: true }, (_event, file) => {
    if (file && String(file).endsWith("assets.generated.ts")) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  });
}

const quit = async () => {
  await stop();
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);

console.log("dev: watching src/, ui/, skill/, templates/. Edit and save; the server restarts after each rebuild.");
start();

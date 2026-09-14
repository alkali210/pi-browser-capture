import { build } from "esbuild";
import { mkdir, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import { zipSync } from "fflate";

await build({ entryPoints: ["src/pi/index.ts"], outfile: "dist/pi/index.js", bundle: true, platform: "node", format: "esm", target: "node22", external: ["ws", "@earendil-works/pi-coding-agent"] });
for (const target of ["chromium", "firefox"]) {
  const outdir = `dist/browser/${target}`;
  await mkdir(outdir, { recursive: true });
  await build({ entryPoints: ["src/browser/background.ts", "src/browser/content.ts", "src/browser/ui.ts"], outdir, bundle: true, platform: "browser", format: "iife", target: ["chrome116", "firefox128"], define: { __FIREFOX__: String(target === "firefox") } });
  for (const file of ["ui.html", "ui.css", "icon.svg"]) await copyFile(`src/browser/${file}`, `${outdir}/${file}`);
  const icons = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icon-${size}.png`]));
  for (const file of Object.values(icons)) await copyFile(`src/browser/${file}`, `${outdir}/${file}`);
  await writeFile(`${outdir}/THIRD-PARTY-NOTICES.txt`, `Bundled dependency: webextension-polyfill 0.12.0\nSource: https://github.com/mozilla/webextension-polyfill/tree/0.12.0\nUnmodified library bundled by esbuild.\n\n${await readFile("node_modules/webextension-polyfill/LICENSE", "utf8")}`);
  const manifest = {
    manifest_version: 3, name: "Pi Browser Capture", version: "0.1.0",
    description: "选取网页，将截图和 DOM 添加到本机 Pi 草稿。",
    icons,
    permissions: ["activeTab", "scripting", "storage", "alarms"],
    optional_permissions: ["cookies"],
    host_permissions: ["http://127.0.0.1/*"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    action: { default_popup: "ui.html", default_title: "添加网页选区到 Pi", default_icon: icons },
    commands: { "capture-region": { suggested_key: { default: "Alt+Shift+P" }, description: "框选网页并添加到 Pi" } },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'self' ws://127.0.0.1:*" },
    ...(target === "firefox" ? {
      background: { scripts: ["background.js"] },
      browser_specific_settings: { gecko: { id: "pi-browser-capture@local.pi", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } } }
    } : { minimum_chrome_version: "116", background: { service_worker: "background.js" } })
  };
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  const files = {};
  for (const name of await readdir(outdir)) files[name] = new Uint8Array(await readFile(`${outdir}/${name}`));
  await writeFile(`dist/pi-browser-capture-${target}.zip`, zipSync(files, { level: 6 }));
}
console.log("Built Pi extension and Chromium / Firefox packages.");

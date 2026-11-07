// 将 package.json 的 version 同步到项目内其他版本号位置，并暂存改动。
// 由 `npm version <x.y.z>` 的 version 生命周期自动执行（发生在生成版本 commit / tag 之前），
// 这样一次 `npm version` 就能让 package.json、Cargo.toml、Cargo.lock、tauri.conf.json 保持一致。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (!version) throw new Error("package.json 缺少 version 字段");

const changed = [];

const sync = (file, transform) => {
  const before = readFileSync(file, "utf8");
  const after = transform(before);
  if (after === before) return;
  writeFileSync(file, after);
  changed.push(file);
};

// Cargo.toml 的 [package] version
sync("src-tauri/Cargo.toml", (text) =>
  text.replace(/^version = ".*"$/m, `version = "${version}"`)
);

// tauri.conf.json 的应用版本
sync("src-tauri/tauri.conf.json", (text) => {
  const conf = JSON.parse(text);
  conf.version = version;
  return JSON.stringify(conf, null, 2) + "\n";
});

// Cargo.lock 里本包的版本条目（避免 cargo check 再产生未提交改动）
sync("src-tauri/Cargo.lock", (text) =>
  text.replace(
    /(\[\[package\]\]\nname = "orbit-data"\nversion = ")[^"]*(")/,
    `$1${version}$2`
  )
);

if (changed.length > 0) {
  execFileSync("git", ["add", ...changed], { stdio: "inherit" });
}

console.log(`版本已同步为 ${version}：${changed.join(", ") || "无需要更新的文件"}`);

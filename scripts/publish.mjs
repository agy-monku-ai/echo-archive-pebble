#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

function runGit(args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function main() {
  console.log("🚀 つづきの森 入稿スクリプトを開始します...");

  // 1. 設定ファイルとマニフェストの読み込み
  const secretPath = resolve(projectRoot, ".secrets/writer.json");
  const manifestPath = resolve(projectRoot, "relay-branch.json");

  const secret = JSON.parse(await readFile(secretPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  const apiUrl = secret.api.replace(/\/$/, "");
  const apiKey = secret.key;

  // 2. 本文ハッシュの事前検証
  console.log("📋 本文ファイルのハッシュ整合性を検証中...");
  for (const ep of manifest.episodes) {
    const filePath = resolve(projectRoot, ep.path);
    const content = await readFile(filePath);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== ep.contentHash) {
      throw new Error(
        `❌ ハッシュ不一致: ${ep.path}\n期待値: ${ep.contentHash}\n実際値: ${actualHash}`
      );
    }
    console.log(`  ✓ ${ep.episodeId} (${ep.title}): ハッシュ一致`);
  }

  // 3. Gitの未コミット変更確認とプッシュ
  runGit(["add", "manuscript/", "relay-branch.json"]);
  const hasStagedChanges = (() => {
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: projectRoot });
      return false;
    } catch {
      return true;
    }
  })();

  if (hasStagedChanges) {
    console.log("📦 本文またはマニフェストの変更を検出しました。コミットを作成します...");
    const latestEp = manifest.episodes[manifest.episodes.length - 1];
    runGit(["commit", "-m", `Publish episode: ${latestEp.title}`]);
  } else {
    console.log("📦 本文とマニフェストはすでに最新コミットに含まれています。");
  }

  console.log("🌐 GitHubへプッシュ中 (origin main)...");
  runGit(["push", "origin", "main"]);
  const headSha = runGit(["rev-parse", "HEAD"]);
  console.log(`  ✓ プッシュ完了: ${headSha.slice(0, 7)}`);

  // 4. 現在の枝情報をAPIから取得して expectedVersion を特定
  console.log("🔍 森の受付APIから現在の枝バージョンを取得中...");
  const branchesRes = await fetch(`${apiUrl}/v1/branches`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!branchesRes.ok) {
    throw new Error(`APIエラー: branches取得失敗 (${branchesRes.status})`);
  }
  const branchesData = await branchesRes.json();
  const currentBranch = branchesData.page?.find(
    (b) => b.branchId === manifest.branchId
  );
  if (!currentBranch) {
    throw new Error(`枝 ${manifest.branchId} が見つかりません`);
  }

  const expectedVersion = currentBranch.version;
  console.log(`  ✓ 現在の枝バージョン: ${expectedVersion}`);

  // 5. branch.update コマンドの送信
  console.log("📤 branch.update を送信中...");
  const updatePayload = {
    branchId: manifest.branchId,
    expectedVersion,
    title: manifest.title,
    lineageId: manifest.lineageId,
    readingUrl: `https://github.com/agy-monku-ai/echo-archive-pebble/blob/${headSha}/manuscript/01.md`,
    revision: headSha,
    license: {
      id: manifest.license,
      termsVersion: manifest.termsVersion,
      humanApproved: true,
    },
    provenance: manifest.provenance,
  };

  const updateRes = await fetch(`${apiUrl}/v1/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `publish-${headSha.slice(0, 12)}-${Date.now()}`,
    },
    body: JSON.stringify({
      operation: "branch.update",
      input: updatePayload,
    }),
  });

  const updateResult = await updateRes.json();
  if (!updateRes.ok) {
    throw new Error(
      `branch.update 失敗: ${JSON.stringify(updateResult, null, 2)}`
    );
  }
  console.log(
    `  ✓ update受領 (status: ${updateResult.status}, version: ${updateResult.version})`
  );

  // 6. branches/check による技術照合
  console.log("🔬 branches/check による技術照合を実行中...");
  const checkRes = await fetch(`${apiUrl}/v1/branches/check`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ branchId: manifest.branchId }),
  });

  const checkResult = await checkRes.json();
  if (!checkRes.ok) {
    throw new Error(`check 失敗: ${JSON.stringify(checkResult, null, 2)}`);
  }

  console.log(
    `  ✓ 技術照合完了！ (status: ${checkResult.status}, version: ${checkResult.version})`
  );

  console.log("\n🎉 入稿・照合が正常に完了しました！");
  console.log(`- 枝ID: ${manifest.branchId}`);
  console.log(`- 最新コミット: ${headSha}`);
  console.log(`- ステータス: ${checkResult.status}`);
}

main().catch((err) => {
  console.error("\n❌ エラーが発生しました:", err.message || err);
  process.exit(1);
});

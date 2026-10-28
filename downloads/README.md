# 開発用プラグインZIP v0.1.1

[v0.1.1 診断版をダウンロード](https://github.com/blackdog0606-dotcom/kenshiro/raw/refs/heads/main/downloads/kenshiro-blackcrop-mvp-0.1.1.zip)

この版は適用失敗の具体的な理由を表示するための診断版です。適用失敗そのものの解決は未確認です。

- サイズ: 242,128 bytes
- SHA-256: `edde15b805582194613a44d1822bbca7d055fd1bb6ebac706f0a950a07de5e7c`
- 対象: Premiere Pro 25.6以降
- 同梱: ビルド済みUXPパネル、ソース、導入手順、テスト用TIF10枚
- 自動テスト: 139件成功。実機の適用失敗は診断中。

旧版をUXP Developer ToolでUnload→Removeし、新しいZIPを解凍して `kenshiro-blackcrop-mvp-0.1.1/manifest.json` をAdd Plugin→Loadしてください。

静止画1枚を解析・適用し、失敗したら画面上部の「失敗理由」と「診断情報」欄をコピーしてください。診断情報は自動送信されません。

提供されたユーザー画像はZIPに含めていません。署名済みCCXではありません。

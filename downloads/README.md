# 開発用プラグインZIP v0.1.2

[v0.1.2 起動処理修正版をダウンロード](https://github.com/blackdog0606-dotcom/kenshiro/raw/refs/heads/main/downloads/kenshiro-blackcrop-mvp-0.1.2.zip)

ボタンの初期化をDOM準備時にも実行し、起動失敗を独立スクリプトで表示します。診断の無期限待機を防ぎ、診断中も他の操作をロックしません。実機でのCrop適用成功はまだ確認できていません。

- サイズ: 252,463 bytes
- SHA-256: `4ca9f48afdbf0918556e8cb0cf2ffef040678bb923ce0a110a1b7662d2704977`
- 対象: Premiere Pro 25.6以降
- 自動テスト: 162件成功
- 同梱: ビルド済みUXPパネル、ソース、導入手順、生成したテスト用TIF10枚

旧版をUXP Developer ToolでUnload→Removeし、新しいZIPの `kenshiro-blackcrop-mvp-0.1.2/manifest.json` をAdd Plugin→Loadしてください。

まずパネル上部に「起動済み v0.1.2」が出ることを確認してください。「起動・実行エラー」が出たらその文章を報告してください。起動後に1枚だけ解析・適用し、失敗した場合は上部の失敗理由と診断情報欄を報告してください。

APP LOGSに `[Kenshiro] bootstrap v0.1.2` と `[Kenshiro] ready v0.1.2` が記録されます。診断情報は自動送信されません。提供されたユーザー画像はZIPに含めていません。署名済みCCXではありません。

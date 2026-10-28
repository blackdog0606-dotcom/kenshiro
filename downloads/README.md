# 開発用プラグインZIP

[kenshiro-blackcrop-mvp.zip をダウンロード](https://github.com/blackdog0606-dotcom/kenshiro/raw/refs/heads/main/downloads/kenshiro-blackcrop-mvp.zip)

- バージョン: 0.1.0
- サイズ: 229,521 bytes
- SHA-256: `314c04f643fdb22e2c529e45c936be8134fbb513aec69422c9cac242c4282845`
- 対象: Premiere Pro 25.6以降
- 同梱: ビルド済みUXPパネル、ソース、導入手順、テスト用TIF10枚

ZIPを解凍し、UXP Developer Toolで `kenshiro-blackcrop-mvp/manifest.json` を読み込みます。署名済みCCXではないため、ZIPをPremiereで直接開いてインストールする形式ではありません。

125件の自動テストを実行済みです。Premiere実機での適用は未検証なので、まず1枚で解析値とCropの表示値が一致するか確認してください。

提供されたユーザー画像は、このZIPに含めていません。

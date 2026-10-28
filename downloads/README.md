# 開発用プラグインZIP v0.1.3

[v0.1.3 標準Crop識別修正版をダウンロード](https://github.com/blackdog0606-dotcom/kenshiro/raw/refs/heads/main/downloads/kenshiro-blackcrop-mvp-0.1.3.zip)

Premiere Pro 26.5.2の実機診断で標準Cropの内部名が `AE.ADBE AECrop` と確認できました。旧版がこの名前を認識せず適用前に停止する不具合を修正しています。第三者製 `AE.Impact_Crop_FX` やMotionを代替として変更しません。小さいウィンドウでも結果が隠れないよう、状態表示を上部へ移動して画面全体をスクロール可能にしました。

- サイズ: 252,745 bytes
- SHA-256: `58a0d514e53ef6c3c585d228639e138cd43feef103e0c2d7cd93ace5459c927c`
- 対象: Premiere Pro 25.6以降
- 自動テスト: 166件成功
- 同梱: ビルド済みUXPパネル、ソース、導入手順、生成したテスト用TIF10枚

旧版をUXP Developer ToolでUnload→Removeし、新しいZIPの `kenshiro-blackcrop-mvp-0.1.3/manifest.json` をAdd Plugin→Loadしてください。

見出しがv0.1.3になったら、タイムラインの静止画1枚を選択し、検出モード「白い余白＋黒いコマ枠」で①解析→②適用してください。

今回の実機エラーの原因は特定済みですが、修正後の実機適用成功はまだ未確認です。失敗した場合は上部の具体的な失敗理由を報告してください。提供されたユーザー画像はZIPに含めていません。署名済みCCXではありません。

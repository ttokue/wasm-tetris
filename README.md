# WASM Tetris

スマホのブラウザで遊べる、静的ファイルだけのテトリスです。

## 遊び方

このフォルダを静的サーバーで配信して `index.html` を開きます。

```sh
python -m http.server 4173
```

ブラウザで `http://localhost:4173/` を開いてください。

## 実装済みの機能

- WebAssembly による衝突判定とブロック固定
- 7-bag ランダム
- ゴースト表示
- ボタン操作とスワイプ操作
- ライン消去エフェクト
- 端末内ハイスコア保存

## 無料で公開する方法

バックエンド、データベース、常駐サーバーは不要です。`index.html`、`styles.css`、`app.js` をそのまま GitHub Pages、Cloudflare Pages、Netlify などの無料静的ホスティングに置けば公開できます。

ゲームの衝突判定とブロック固定処理は、ブラウザ内で生成した WebAssembly モジュールで実行します。描画、タッチ操作、スコア表示は JavaScript と Canvas が担当します。

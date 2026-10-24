# 錄音／影音檔轉錄：第二階段需求

2026-10-24

目前語音收藏只支援兩種方式：貼上逐字稿，以及用瀏覽器的 Web Speech API 口述（`web/lib/voice.mjs`）。**錄音檔或影音檔上傳後自動轉逐字稿尚未實作**，介面上也不放上傳按鈕；`web/lib/transcribe.mjs` 只定義了 adapter 介面和「未設定提供者」的實作。

## 為什麼還不做

- 收藏網頁存著 GitHub token，規則是不載入任何第三方 JS；ASR 服務的金鑰也不能放在前端。
- 需要先決定：提供者（例如 OpenAI Whisper API、Google Speech-to-Text、自架 whisper.cpp）、每分鐘費用、檔案大小上限、隱私（音檔會送到哪裡、保留多久）、客語等語言的辨識品質。
- 在這些決定之前宣稱「支援 Whisper」會誤導使用者。

## adapter 介面（`web/lib/transcribe.mjs`）

```js
{
  id: 'provider-id',
  label: '顯示名稱',
  available(): Promise<{ ok: boolean, reason?: string }>,
  transcribe(file, { lang, signal }): Promise<{ text, segments?: [{ start, end, text }], provider, model? }>
}
```

## 建議的實作方向（擇一）

| 方案 | 金鑰放哪 | 優點 | 缺點 |
|---|---|---|---|
| A. 收藏庫 Actions 轉錄 | 收藏庫 Actions secret | 不需要伺服器；與分析同一套權限模型 | 音檔要先上傳到私人 repo（大小限制、git 歷史會變大），不即時 |
| B. 使用者自己的小型後端（例如 Cloudflare Worker） | Worker secret | 即時、可串流 | 多一個要維護的服務，違反「零伺服器」原則 |
| C. 本機轉錄（whisper.cpp 等） | 不需要 | 隱私最好、免費 | 只在電腦上可用，需要安裝 |

## 驗收條件（實作時）

- 轉錄結果一律先讓使用者確認／修改，才擷取 GitHub 網址（與現在的逐字稿流程相同）。
- 處理不支援的格式、檔案過大、取消上傳、提供者失敗、費用上限，每種都有可恢復的錯誤訊息。
- 音檔與逐字稿不出現在公開位置；token 與提供者金鑰不進前端、不進 git、不進日誌。
- 文件寫清楚費用與資料流向。

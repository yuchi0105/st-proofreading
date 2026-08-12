# 酒館卡片校對台

繁化 SillyTavern 角色卡時，轉換器常常把**程式要讀的字串**一起改掉 —— 世界書條目名稱、`key=value` 設定鍵、腳本按鈕名。這類失敗不會報錯，只會表現成「功能時好時壞」。

校對台會先把這些字串標記保護、再進行轉換；已經壞掉的卡也能直接診斷修復。

**線上使用：** https://yuchi0105.github.io/st-proofreading/

> ⚠️ 個人自製的非官方工具，與 SillyTavern 官方、各轉換器作者及任何角色卡作者均無關聯。
> 轉換結果請自行確認後再使用，並記得先備份原卡。

Made by **YUCHI**

## 功能

- 支援角色卡 PNG／JSON、世界書 JSON、預設 JSON、正則腳本 JSON
- 正則腳本可以單獨拖進來轉換（單一條或一整包都收），`{{巨集}}`、HTML 標籤、網址與色碼會自動保護
- 自動分類條目：**資料**（腳本讀取，鍵名須維持簡體）／**提示詞**（AI 讀取，全部轉繁體）
- 校對報告與風險稽核
- 可勾選要套用的修正，選擇轉換方向
- 匯出 PNG／JSON／校對報告

## 隱私與離線

檔案完全在瀏覽器本機處理，不會上傳到任何伺服器。

繁簡轉換用的 [OpenCC](https://github.com/nk2028/opencc-js) 詞庫**已內嵌在 `index.html` 裡**，執行時不會對外連任何一個網址。頁面載入完成後就能整台斷網使用，也可以把 `index.html` 存到本機直接用瀏覽器開。

## 更新方式

網站的內容就是根目錄的 `index.html` —— 單一檔案，不依賴任何外部資源。

要更新時，**請直接覆蓋 `index.html`**，不要另外上傳成別的檔名 —— GitHub Pages 只會把 `index.html` 當成首頁。推上 `main` 分支後，等一兩分鐘網站就會自動更新。

⚠️ 檔案末端 `OPENCC-BUNDLE:BEGIN` / `OPENCC-BUNDLE:END` 之間是內嵌的 OpenCC 詞庫（約 1 MB）。**更新自己的程式碼時請保留這整段**，刪掉的話繁簡轉換就會失效（會退回嘗試連 CDN）。

要換新版 OpenCC 的話，把那兩個標記之間 `<script>` 裡的內容整段換成新版的 `dist/umd/full.js` 即可。

## 第三方元件

- [opencc-js](https://github.com/nk2028/opencc-js) v1.0.5 — MIT License, Copyright (c) 2020-2021 The nk2028 Project。完整授權條款附於 `index.html` 內嵌區塊的註解中。

# tools/slice:GPT 精靈表切圖工具

純 Node(只用內建 zlib,無 npm 套件)。把 GPT 產的洋紅底 PNG 切成單格、去背、腳底對齊、打包成圖集。

## 用法

    node tools/slice/slice.mjs <設定.json> [--out 輸出資料夾]

輸出 `atlas.png` + `atlas.json`(預設寫到設定檔旁 `out/`,或設定的 `out`,正式素材放 `data/art/<角色id>/`)。

## 設定檔(路徑相對於設定檔)

    {
      "out": "../../data/art/ada",
      "sheets": [
        { "file": "ada_01.png", "cols": 3, "rows": 2,
          "frames": ["idle_0", "idle_1", "walk_0", "walk_1", { "name": "jump_up", "air": true }, null] },
        { "file": "ada_wide.png", "cols": 3, "rows": 2, "layout": "components",
          "frames": [{ "name": "sp_fwd_jump_0", "wide": true }, "sp_fwd_jump_1"] }
      ]
    }

- `frames` 依列優先(左到右、上到下);`null` = 該格不用;字串 = 幀名;物件可加:
  `wide`(寬招 256×160,僅用於超寬警告判斷)、`air`(空中格,見下)、`dx`/`dy`(輸出像素微調錨點)、`anchorX`(`cell` 畫格中心[grid 預設]/ `bbox` 內容中心[components 預設]/ `feet` 底部 8% 內容的 x 中心,可設在 sheet、全域或單格)。
- `layout`:`grid`(預設,依 cols×rows 等分,每格取內容邊界框)或 `components`(連通區域,格線不整齊時用;近距離碎塊用 `mergeGap` 合併、`minArea` 濾雜點;數量不符直接報錯)。
- sheet 可選:`key`(只對該張覆蓋去背參數)、`despeckle`(清掉面積小於此值的孤立雜點,webp 圖用)、`footBand`。`key.bg:"auto"` = 背景色取四角內插(吃偏色 / 漸層),並濾掉畫格間 4px 內的白 / 粉紅細線(`key.lineBand`、`key.lines:false` 可調)。偏色圖 `lo/hi` 建議 0.15/0.5、`edge` 3。
- 全域可選:`scale`(預設 auto = 160 ÷ 來源格高)、`cell`、`wideCell`、`footOffset`(8)、`pxPerUnit`(2)、`key:{lo,hi,edge}`、`maxW/maxH`(2048)。

## 做了什麼

1. 去背:洋紅度 `(min(R,B)-G)/255`;>= hi 全透明;緊貼透明區 `edge` 像素內的抗鋸齒邊,依洋紅混色比例解混去色溢並產生半透明。內部像素不動(角色自身的粉紅 / 紫不受影響)。輸入若已有透明就略過去背。
2. 腳底對齊:一般格內容底部 = 腳底線(`ay` = 格高);`air:true`(grid)保留畫格幾何,地線 = 來源格底往上 8 輸出像素,所以請 GPT 把跳 / 擊飛格的身體畫在格內相對地線的正確高度。`ax` = 畫格水平中心(grid)。
3. 預乘 alpha 區域平均縮小,貨架式打包(間隔 2 px,超過 2048 報錯)。
4. `atlas.json`:`{ image, pxPerUnit, size, cell, wideCell, footOffset, frames:{ 名稱:{x,y,w,h,ax,ay[,wide]} } }`。`ax, ay` = 腳底中心在該格裡的像素位置;遊戲端把它對到角色腳底座標。

## 限制

- 避免角色身上出現接近純洋紅 / 高飽和紫(洋紅度 >= 0.8)的大面積色,會被當背景。
- 只支援 8-bit 非交錯 PNG。grid 版面不做雜點清除(GPT 圖若有雜點會撐大邊界框,改用 components 或請 GPT 重畫)。

## 測試(圖全由程式生成)

    node tools/slice/test/run-test.mjs      # 切圖:去背、對齊、打包、components、CLI
    node tools/slice/test/render-test.mjs   # 渲染端:用假圖集驗證選幀 / 翻轉 / 退回(產物在 test/fake-art/)

## 渲染端對照(資料在 data/chars/<id>.json 的 `art` 欄位)

`art.states.<狀態名>` / `art.moves.<招式名>` = `{ mode, frames:[幀名], rate, total, at }`;mode:`loop`、`hold`、`vy`(上升/頂點/下落)、`progress`(依 `total`=數字或 def 路徑如 `roll.dur`)、`stunt`(輕/重)、`move`(依招式邏輯格)。招式表優先於狀態表。找不到圖集、動畫或幀名時自動退回色塊佔位圖。

## 來源圖是 webp 時

工具只吃 PNG。先用 Pillow 轉到 `tools/slice/tmp/`(可隨時刪):`Image.open(f).convert('RGB').save(...)`;設定檔 `guanyu.json` 即引用該資料夾。已存在的角色設定:`areh.json`、`guanyu.json`、`magnet.json`、`sun.json`(不含必殺 / 大招 / 射彈)。磁鈴 / 小孫第 4 張只有第 1 排有角色,角色腳底超出 3 等分的第 1 排高度,所以第 4 張設為 `rows:2`(後 4 格 null);scale 用 0.32 讓身高與關羽接近(來源格內人物較大)。

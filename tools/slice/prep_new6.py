# 新 6 角色(小豬豬 / 騎玉 / 小志 / 柯南 / 籠卷 / 漫漫龜)基本動作:webp → tmp/<id>_<N>.png
# 小志第 3 張 = A(格 1~4)+ B(格 5~8)+ C(格 9~12)三段、柯南第 3 張 = 前 8 格 + 後 4 格:
# 各段圖都是 4 欄 x 3 列同格位(每列高 362),所以直接把有角色的整列(1448x362)貼到新畫布對應列即可,格位順序同其他角色第 3 張。
import os, sys
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', '給GPT', '回收')
OUT = os.path.join(HERE, 'tmp')
os.makedirs(OUT, exist_ok=True)
NAMES = {'piggy': '小豬豬', 'qiyu': '騎玉', 'longjuan': '籠卷', 'manman': '漫漫龜', 'xiaozhi': '小志', 'kenan': '柯南'}
def conv(src, dst):
    Image.open(os.path.join(SRC, src)).convert('RGB').save(os.path.join(OUT, dst))
for cid, n in NAMES.items():
    for i in (1, 2, 3, 4):
        if cid == 'xiaozhi' and i == 3: continue
        if cid == 'kenan' and i == 3: continue
        conv('%s_第%d張.webp' % (n, i), '%s_%d.png' % (cid, i))

def segs(im, n):
    # 只有第一排的圖:角色高度可超出 362 的列高,所以用欄投影切出 n 個角色(回傳 (x0, y0, x1, y1)),再各貼到新畫布列內對應格
    import numpy as np
    a = np.asarray(im).astype(int)
    fg = (np.minimum(a[:, :, 0], a[:, :, 2]) - a[:, :, 1]) <= 120
    cols = fg.sum(axis=0) > 0
    runs = []; st = None; gap = 0; en = 0
    for x in range(len(cols)):
        if cols[x]:
            if st is None: st = x
            gap = 0; en = x
        elif st is not None:
            gap += 1
            if gap >= 10: runs.append((st, en + 1)); st = None
    if st is not None: runs.append((st, en + 1))
    runs = [r for r in runs if r[1] - r[0] > 40]
    assert len(runs) == n, (len(runs), runs)
    out = []
    for x0, x1 in runs:
        ys = np.where(fg[:, x0:x1].sum(axis=1) > 0)[0]
        out.append((x0, int(ys[0]), x1, int(ys[-1]) + 1))
    return out
def stitch(dst, parts):
    # parts: [(來源檔, 'row' 整列貼 / 'seg', 來源列, 目的列)]
    # 新畫布列高 440(原圖 362;小志有格高 378、柯南 406 的角色),像素 1:1 不縮放,所以 scale 與其他張一致
    W, H = 1448, 1086
    RH = H // 3
    NH = 440
    out = Image.new('RGB', (W, NH * 3), (255, 0, 255))
    for f, kind, sr, dr in parts:
        im = Image.open(os.path.join(SRC, f)).convert('RGB')
        if kind == 'row':
            out.paste(im.crop((0, sr * RH, W, (sr + 1) * RH)), (0, dr * NH + (NH - RH) // 2))
        else:
            for c, (x0, y0, x1, y1) in enumerate(segs(im, 4)):
                ch = im.crop((x0, y0, x1, y1))
                assert x1 - x0 <= W // 4 and y1 - y0 <= NH - 20, (f, c, x1 - x0, y1 - y0)
                out.paste(ch, (c * (W // 4) + (W // 4 - (x1 - x0)) // 2, dr * NH + (NH - (y1 - y0)) // 2))
    out.save(os.path.join(OUT, dst))
stitch('xiaozhi_3.png', [('小志_第3張_A_前4格.webp', 'seg', 0, 0), ('小志_第3張_B.webp', 'seg', 0, 1), ('小志_第3張_C.webp', 'seg', 0, 2)])
stitch('kenan_3.png', [('柯南_第3張_前8格.webp', 'row', 0, 0), ('柯南_第3張_前8格.webp', 'row', 1, 1), ('柯南_第3張_後4格.webp', 'seg', 0, 2)])

# 必殺技美術前處理:把 給GPT/回收/必殺技_*.webp 轉成 PNG(tools/slice/tmp/ult_<id>_<N>.png),
# 並把「烘進姿勢格」的特效擦成洋紅底(特效另用獨立特效格,避免重複顯示)。
# 用法:python tools/slice/ult_prep.py   (需要 Pillow)
import os
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '..', '..', '給GPT', '回收')
TMP = os.path.join(ROOT, 'tmp')
IDS = {'小孫': 'sun', '磁鈴': 'magnet', '阿熱': 'areh', '關羽': 'guanyu', '呂布': 'lubu'}
MAG = (255, 0, 255)


def erase(im, box, keep):
    """box 內不符合 keep(r,g,b) 的像素全部改成洋紅(含抗鋸齒雜邊)"""
    px = im.load()
    x0, y0, x1, y1 = box
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y][:3]
            if not keep(r, g, b):
                px[x, y] = MAG


def skin_or_dark(r, g, b):
    if max(r, g, b) < 110:
        return True  # 黑外框
    return r - b >= 22  # 膚色 / 橘衣(偏紅黃);氣功波是白 / 青 / 藍,洋紅底 R≈B,都不符合


for ch, cid in IDS.items():
    for n in range(1, 5):
        f = os.path.join(SRC, '必殺技_%s_第%d張.webp' % (ch, n))
        if not os.path.exists(f):
            continue
        im = Image.open(f).convert('RGB')
        if cid == 'sun' and n == 1:
            # 第 2 格(氣功發射)手掌前烘進去的氣功波:手掌右側整塊擦掉(鞋底白色高光在 y>=300,不動)
            erase(im, (596, 100, 785, 300), skin_or_dark)
            erase(im, (626, 296, 785, 345), skin_or_dark)
        if cid == 'magnet' and n == 1:
            # 第 8 格(全力發射)手掌前烘進去的光束:手掌右側整塊擦掉,手臂電弧留著
            erase(im, (812, 845, 965, 935), lambda r, g, b: False)
        out = os.path.join(TMP, 'ult_%s_%d.png' % (cid, n))
        os.makedirs(TMP, exist_ok=True)
        im.save(out)
        print('->', os.path.basename(out), im.size)

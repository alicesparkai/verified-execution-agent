# -*- coding: utf-8 -*-
"""build_video.py — собрать питч-видео: слайды + синхронная озвучка.

ЛОГИКА: каждый кадр держится РОВНО столько, сколько длится его фраза. Не «примерно
по 12 секунд», а точно по длине wav — иначе голос уедет от картинки к третьему кадру.

Собирает: снимок каждого слайда через браузер → видеодорожка с точными длительностями →
склейка всех wav в одну звуковую дорожку → сведение через ffmpeg из imageio.
"""
import glob, os, re, subprocess, sys, wave

BASE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(BASE, "shots")
OUT = os.path.join(BASE, "VEA_pitch.mp4")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def найти_voice():
    """Голосовые файлы: PowerShell мог положить их по искажённому пути (кириллица)."""
    прямой = os.path.join(BASE, "voice")
    if glob.glob(os.path.join(прямой, "v*.wav")):
        return прямой
    for c in glob.glob("C:/**/pitch/voice", recursive=True):
        if glob.glob(os.path.join(c, "v*.wav")):
            return c
    raise SystemExit("не нашла папку voice с wav")


def длительности(vdir):
    fs = sorted(glob.glob(os.path.join(vdir, "v*.wav")),
                key=lambda p: int(re.search(r"v(\d+)", os.path.basename(p)).group(1)))
    out = []
    for f in fs:
        with wave.open(f) as w:
            out.append((f, w.getnframes() / w.getframerate()))
    return out


def склеить_звук(файлы, цель):
    """Один wav из семи. Параметры берём у первого — синтез даёт одинаковые."""
    with wave.open(файлы[0]) as w0:
        params = w0.getparams()
    with wave.open(цель, "wb") as out:
        out.setparams(params)
        for f in файлы:
            with wave.open(f) as w:
                out.writeframes(w.readframes(w.getnframes()))
    return цель


def main():
    vdir = найти_voice()
    пары = длительности(vdir)
    print("кадров:", len(пары), "| суммарно %.1f сек" % sum(d for _, d in пары))

    кадры = sorted(glob.glob(os.path.join(SHOTS, "s*.png")),
                   key=lambda p: int(re.search(r"s(\d+)", os.path.basename(p)).group(1)))
    if len(кадры) != len(пары):
        raise SystemExit("снимков %d, а фраз %d — сначала сделай снимки слайдов" % (len(кадры), len(пары)))

    # ── видеодорожка: каждый кадр держится ровно длину своей фразы ──
    import numpy as np, imageio.v2 as iio
    from PIL import Image
    FPS = 10
    w0, h0 = Image.open(кадры[0]).size
    w0 -= w0 % 2; h0 -= h0 % 2
    немое = os.path.join(BASE, "_silent.mp4")
    writer = iio.get_writer(немое, fps=FPS, codec="libx264", quality=8, macro_block_size=None)
    try:
        for путь, (_, сек) in zip(кадры, пары):
            arr = np.array(Image.open(путь).convert("RGB").resize((w0, h0), Image.LANCZOS))
            for _ in range(max(1, int(round(сек * FPS)))):
                writer.append_data(arr)
            print("  кадр %s → %.1f сек" % (os.path.basename(путь), сек))
    finally:
        writer.close()

    звук = склеить_звук([f for f, _ in пары], os.path.join(BASE, "_voice.wav"))

    # ── сведение: ffmpeg лежит внутри imageio, ставить ничего не нужно ──
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([ff, "-y", "-i", немое, "-i", звук,
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", OUT],
                   capture_output=True, timeout=300)
    if os.path.exists(OUT):
        print("\n✅ готово: %s (%d КБ)" % (OUT, os.path.getsize(OUT) // 1024))
    else:
        print("\n⛔ ffmpeg не собрал файл")


if __name__ == "__main__":
    main()

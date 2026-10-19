#!/usr/bin/env python3
"""用一个音轨证明"指挥室能做音乐"：只用 numpy 合成一段电音 loop，存成 WAV。

为什么这么做：DAW 是 GUI 软件，AI 成员无法可靠操作它（模拟点击脆弱且不可复现）。
但"生成音频"这件事完全可以用代码做——不需要任何 DAW、不需要额外安装。

本脚本零依赖（只用 numpy），演示四类要素：
  - 鼓：底鼓（正弦扫频）、hi-hat（噪声+包络）
  - 贝斯：锯齿波 + 低通（这里用一个简单的一阶滤波近似）
  - 琶音：方波 + 音高序列
  - 混音：总线软削波 + 淡入淡出

用法：python scripts/make-music-demo.py [输出路径]
"""
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100          # 采样率
BPM = 124
BEAT = 60.0 / BPM   # 一拍秒数
BARS = 4
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("music-demo.wav")

# 音名 -> 频率（A4=440）
def note(name: str) -> float:
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    pitch, octave = name[:-1], int(name[-1])
    semitones = names[pitch] + (octave - 4) * 12 - 9  # 相对 A4
    return 440.0 * (2 ** (semitones / 12))


def adsr(length: int, attack=0.005, decay=0.08, sustain=0.6, release=0.12) -> np.ndarray:
    """简单包络。返回长度 length 的增益曲线。"""
    a = int(attack * SR)
    d = int(decay * SR)
    r = int(release * SR)
    s = max(0, length - a - d - r)
    env = np.concatenate([
        np.linspace(0, 1, a, endpoint=False) if a else np.array([]),
        np.linspace(1, sustain, d, endpoint=False) if d else np.array([]),
        np.full(s, sustain),
        np.linspace(sustain, 0, r) if r else np.array([]),
    ])
    if len(env) < length:
        env = np.pad(env, (0, length - len(env)))
    return env[:length]


def kick(dur=0.28) -> np.ndarray:
    """底鼓：频率从 150Hz 快速下扫到 50Hz。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    freq = 150 * np.exp(-38 * t) + 50
    phase = 2 * np.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * np.exp(-9 * t)
    click = np.random.default_rng(1).normal(0, 0.25, n) * np.exp(-90 * t)
    return (body + click) * 0.95


def hat(dur=0.05) -> np.ndarray:
    """踩镲：高通噪声 + 极短包络。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = np.random.default_rng(2).normal(0, 0.35, n)
    # 简单一阶差分近似高通
    noise = np.diff(noise, prepend=0.0)
    return noise * np.exp(-70 * t)


def saw(freq, dur, detune=0.0):
    """锯齿波（多个谐波叠加近似），可选失谐制造厚度。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for harmonic in range(1, 18):
        out += np.sin(2 * np.pi * freq * (1 + detune) * harmonic * t) / harmonic
    return out * 0.5


def square(freq, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for harmonic in range(1, 20, 2):
        out += np.sin(2 * np.pi * freq * harmonic * t) / harmonic
    return out * 0.55


def lowpass(x, cutoff=0.12):
    """一阶低通（用指数滑动平均近似）。cutoff 越小越闷。"""
    out = np.empty_like(x)
    acc = 0.0
    for i, sample in enumerate(x):
        acc += cutoff * (sample - acc)
        out[i] = acc
    return out


def place(track: np.ndarray, sound: np.ndarray, at_seconds: float, gain=1.0):
    start = int(at_seconds * SR)
    end = min(len(track), start + len(sound))
    if start >= len(track):
        return
    track[start:end] += sound[: end - start] * gain


def main():
    total = int(BARS * 4 * BEAT * SR)
    drums = np.zeros(total)
    bass = np.zeros(total)
    arp = np.zeros(total)

    # 鼓：四拍底鼓 + 反拍踩镲
    for beat_index in range(BARS * 4):
        t0 = beat_index * BEAT
        place(drums, kick(), t0, gain=1.0)
        place(drums, hat(), t0 + BEAT * 0.5, gain=0.45)

    # 贝斯：每小节一个长音 + 一个短音（A 小调）
    bass_notes = ["A1", "A1", "F1", "G1"]
    for bar in range(BARS):
        root = bass_notes[bar % len(bass_notes)]
        dur = BEAT * 1.5
        tone = saw(note(root), dur, detune=0.002)
        tone = lowpass(tone, cutoff=0.05)
        place(bass, tone * adsr(len(tone)), bar * 4 * BEAT, gain=0.55)
        short = saw(note(root), BEAT * 0.4)
        place(bass, lowpass(short, 0.06) * adsr(len(short)), bar * 4 * BEAT + BEAT * 2, gain=0.45)

    # 琶音：八分音符跑 A 小调音阶
    pattern = ["A4", "C5", "E5", "G5", "E5", "C5", "A4", "G4"]
    step = BEAT * 0.5
    for bar in range(BARS):
        for index, name in enumerate(pattern):
            start = bar * 4 * BEAT + index * step
            dur = step * 0.9
            tone = square(note(name), dur)
            tone = lowpass(tone, cutoff=0.35)
            place(arp, tone * adsr(len(tone), decay=0.04, sustain=0.35, release=0.06), start, gain=0.28)

    # 混音：先各自归一化，再相加
    def norm(x, peak=0.9):
        m = np.max(np.abs(x)) or 1.0
        return x / m * peak

    mix = norm(drums) * 0.9 + norm(bass) * 0.55 + norm(arp) * 0.42
    # 总线软削波，避免叠加后削顶
    mix = np.tanh(mix * 1.1)
    mix = norm(mix, 0.95)

    # 首尾淡入淡出，避免爆音
    fade = int(0.02 * SR)
    mix[:fade] *= np.linspace(0, 1, fade)
    mix[-fade:] *= np.linspace(1, 0, fade)

    Out = (mix * 32767).astype(np.int16)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(Out.tobytes())

    seconds = total / SR
    print(f"  [ok] {OUT}  {OUT.stat().st_size} 字节  {seconds:.1f} 秒  {BPM} BPM  A 小调")


if __name__ == "__main__":
    main()

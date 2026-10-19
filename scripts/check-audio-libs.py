"""列出当前 Python 环境里可用的音乐/音频库。

用途：判断指挥室能否做"代码生成音乐"这件事——这决定了音乐能力该怎么接。
"""
import importlib

MODULES = [
    "numpy",
    "scipy",
    "soundfile",
    "pydub",
    "mido",
    "pretty_midi",
    "music21",
    "midiutil",
    "lilypond",
]

for name in MODULES:
    try:
        module = importlib.import_module(name)
        version = getattr(module, "__version__", "")
        print(f"  OK  {name:<12} {version}")
    except Exception:
        print(f"  --  {name:<12} 未安装")

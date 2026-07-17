import json
from pathlib import Path

import requests

BASE_URL = "https://cdn.yoyochinese.com/audio/pychart"

OUTPUT = Path(__file__).resolve().parent.parent / "tones"
AUDIO = OUTPUT / "audio"

OUTPUT.mkdir(parents=True, exist_ok=True)
AUDIO.mkdir(parents=True, exist_ok=True)

INITIALS = [
    "",
    "b","p","m","f",
    "d","t","n","l",
    "g","k","h",
    "j","q","x",
    "zh","ch","sh","r",
    "z","c","s",
    "y","w",
]

FINALS = [
    "a","ai","an","ang","ao",
    "e","ei","en","eng","er",
    "i","ia","ian","iang","iao","ie","in","ing","iong","iu",
    "o","ong","ou",
    "u","ua","uai","uan","uang","ui","un","uo",
    "ue",
]

def split_initial_final(syllable):
    for initial in sorted(INITIALS, key=len, reverse=True):
        if initial and syllable.startswith(initial):
            return initial, syllable[len(initial):]
    return "", syllable

session = requests.Session()

metadata = []

checked = 0
found = 0

for initial in INITIALS:
    for final in FINALS:

        syllable = initial + final

        url = f"{BASE_URL}/{syllable}1.mp3"

        r = session.get(url)

        checked += 1

        if r.status_code != 200:
            continue

        print("Found:", syllable)

        found += 1

        init, fin = split_initial_final(syllable)

        for tone in [1,2,3,4]:

            url = f"{BASE_URL}/{syllable}{tone}.mp3"

            audio = session.get(url)

            if audio.status_code != 200:
                continue

            filename = f"{syllable}{tone}.mp3"

            with open(AUDIO / filename, "wb") as f:
                f.write(audio.content)

            metadata.append({
                "syllable": syllable,
                "initial": init,
                "final": fin,
                "tone": tone,
                "audio": f"audio/{filename}",
            })

print(f"\nChecked {checked} candidate syllables")
print(f"Found {found} valid syllables")
print(f"Downloaded {len(metadata)} audio files")

with open(OUTPUT / "metadata.json", "w", encoding="utf8") as f:
    json.dump(metadata, f, indent=2, ensure_ascii=False)
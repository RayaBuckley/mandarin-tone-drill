# Licence and attribution: sentences demo (12 clips)

## Origin
- This demo (`datasets/sentences/demo.json` plus `datasets/sentences/audio/*.mp3`) is a 12-sentence
  subset of the staged easy pack under the pack manifest `manifest/sentences_easy.json` (92 records).
  The ids here are the pack's own ids.
- Upstream of that pack: Wikimedia Commons Lingua Libre sentence recordings, `languageId` Q9192
  (Mandarin), one speaker, Luilui6666 (Commons Q301531, female), recordings dated 2022-01-03.

## Licence per file (real fields, `manifest/licence_per_file.json`)
- Identical for all 12 ids: `licence_tags_found` = ["cc-0", "cc-by-sa-4.0", "multi-license"],
  `has_cc0` = true, `has_cc_by_sa_4` = true, `multi_license` = true, `licence_ok` = true,
  `missing` = [], `shipped` = true.
- Check method as recorded in that file: live Commons API, one call per file, 2026-10-10.
- For each id the pack takes the CC0 option; `attribution_required` reads
  "no under the CC0 option; the CC BY-SA 4.0 option is kept for completeness".
  Author field as recorded: [[User:Luilui6666|Luilui6666]].
- Licence string copied verbatim from the pack manifest `src.licence` into every record and row below:
  "CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0"

## Audio
- The 12 `audio/<id>.mp3` files are unmodified, byte-identical copies of the staged pack files, made
  with `shutil.copyfile` and checked with sha256 against the pack file.
- No re-encode, no trim, no gain. The pack applies its loudness gain at playback only, so a copy stays
  unmodified.

## English glosses
- The English word glosses and the whole-sentence glosses in `demo.json` were written by the assistant
  for this demo. They are not part of the source pack and carry no source licence claim.
- The source pack ships no English gloss: its `english` field is "" for all 92 records, and its
  `english_status` field states that no gloss was invented for any source page.
- Glosses that the assistant was not confident about end with " (check)"; there are none in this demo.

## Per-file licence (all 12 ids)
| id | licence |
|---|---|
| e001 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e012 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e027 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e032 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e034 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e070 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e078 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e082 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e084 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e085 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e093 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |
| e124 | CC0 1.0 OR CC BY-SA 4.0 ({{Multi-license}} = {{cc-0}} + {{cc-by-sa-4.0}}); this pack takes CC0 |

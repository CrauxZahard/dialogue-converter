# Dialogue Converter

A single-page, 100% client-side website that turns a `.docx` or `.txt` dialogue
script into a Unity **`DialogueAsset`** (`.asset` YAML) plus an optional canonical
intermediate `.txt`.

One input file becomes exactly **one** `.asset` + **one** `.txt`. There is no
automatic splitting, no backend, no accounts, and no persistence - files never
leave the browser.

---

## Quick start

Open `index.html` directly (double-click), or serve the folder:

```powershell
python -m http.server 8123
# then visit http://127.0.0.1:8123/
```

Everything needed is vendored (`js/vendor/mammoth.browser.min.js`), so it also
works fully offline.

### Hosting

The site is static - drop the folder on GitHub Pages, Vercel, or Netlify as-is.
No build step.

### Design

Dark developer-console theme: slate surfaces with a "run green" accent,
JetBrains Mono for structure and IBM Plex Sans for body copy. Fonts load from
Google Fonts with system fallbacks, so the tool still works offline. Visible
focus rings on every control, `aria-live` warnings, `role="alert"` errors, and
`prefers-reduced-motion` respected.

---

## How it works

1. **Upload** - drag/drop or pick a `.docx` / `.txt` (max 5 MB). `.docx` is read
   in-browser with [mammoth.js](https://github.com/mwilliamson/mammoth.js)
   `extractRawText`; `.txt` is read with `File.text()`. Unsupported types and
   empty/image-only files are rejected with an error and no download.
2. **Metadata** - asset file name, `title`, `dialogue_id`, `description`,
   `nextSceneName`. Defaults follow the Unity batch generator.
3. **Preview & edit** - every parsed block is editable (type, speaker, text,
   choices, expression, text position) and deletable, with a warnings panel.
4. **Download** - `Download .asset` and `Download .txt`.

### Two input modes

- **Canonical dialect** (e.g. `Ch0_10_TopFloor.txt`) is detected automatically
  and parsed with the same semantics as `BatchDialogueGenerator.ParseDialogueAsset`
  (`TYPE` / `CHAR` / `TEXT` / `EXPRESSION` / `CHOICES`, `;` terminators,
  multi-line `TEXT`, `ParseChoicesRaw`).
- **Freeform prose** (e.g. the `Red Rain Storyline Dialogue (1).docx`) is mapped
  into that dialect first:

  | Input | Output |
  | --- | --- |
  | `Speaker: text` | `TYPE dialogue` + `CHAR Speaker` + `TEXT text;` |
  | `@Player:` + following `- option` lines | `TYPE question` + `CHAR @Player` + `TEXT <>;` + `CHOICES [...]` |
  | Narration / no-colon lines | `TYPE monologue` + `TEXT ...;` (no `CHAR`) |
  | `Monologue:` / `Narrator Monologue:` prefixes | `TYPE monologue` (no `CHAR`) |
  | `[Scene]`, `[TUTORIAL STAGE]`, `--Battle--`, timestamps, `IF ...:`, `(Stage gimmick:)` | kept verbatim as `TYPE monologue` (never silently dropped) |

  Wrapped prose lines are merged when they continue the previous block (the
  previous line has no sentence-ending punctuation and the next starts lower
  case), and adjacent same-speaker lines are merged - mirroring how the shipped
  canonical files were produced. Directive lines always start their own block.

  `- Nadezhda: ...!?` response lines inside a `@Player` choice block are kept as
  literal choice strings (per the PRD edge case); no extra dialogue lines are
  created from them.

### Warnings panel

- Unmapped speakers (kept verbatim, so no portrait resolves): compared against
  the `BuildSpeakerMap()` names.
- `???` speakers.
- Empty-text blocks and question blocks without choices.
- Unknown `TYPE` (defaults to `dialogue`).
- Stage/directive lines kept as monologue.
- A `TEXT` left open at EOF (mirrors the parser flush).

**Portraits:** the web cannot resolve sprite GUIDs. Every `background`,
`char_icon` and `char_fullPortrait` is written as `{fileID: 0}`, `voice_over` is
null, and `expression` stays `0` unless set in the preview. Fill portraits later
in Unity via `Tools/Batch Apply Character Portraits` or
`Tools/Dialogue/Assign Random MyTurn Portraits`.

---

## Output details

`.asset` matches `Assets/Scripts/Scriptable/DialogueScriptable.cs`:

- Header: `%YAML 1.1`, `m_Script ... guid: c1220b904cdf32142a8ad7e98d130775`,
  `m_Name`, `dialogue_id`, `title`, `description`.
- Per line: `type` (`DIALOGUE=0`, `QUESTION=1`, `MONOLOGUE=2`), `text_type`
  (`NORMAL=0`, `CENTER_BOTTOM=1`), `character`, `expression`, `text`
  (YAML-escaped, non-ASCII as `\uXXXX`), `choices`, null sprite/audio stubs,
  `glitch_text`. Matching every committed asset, `text_type` defaults to
  `CENTER_BOTTOM` for monologue lines and `NORMAL` for dialogue/question;
  override it per row in the preview.
- Footer: `nextDialogue: {fileID: 0}`, `nextSceneName`.

No `.meta` is generated - Unity creates it on import.

Default metadata: `dialogue_id=0`, `title=<assetName>`,
`description=Batch generated from <input file>` (matching
`GenerateDialogueAsset()`).

### Re-importing the `.txt` in Unity

`EXPRESSION` is emitted immediately after `TYPE` (before `CHAR`) because
`ParseDialogueAsset` commits a line on `TEXT`; that placement binds the
expression to the intended block. `CHOICES` is emitted on its own line after a
`;`-terminated `TEXT`, which the parser turns into a prompt line plus a
choices-carrying line (a quirk of the canonical parser that can hold text or
choices in one line, never both).

---

## Project layout

```
index.html                 markup
css/styles.css             styling
js/converter.js            conversion core (also runs under Node)
js/app.js                  UI wiring
js/vendor/mammoth.browser.min.js
tools/test-converter.cjs   core checks (no dependencies)
```

Preview paginates (50/100/250 rows) so large scripts stay responsive.

---

## Tests

```powershell
node tools/test-converter.cjs
```

Optional overrides: `UNITY_PROJECT` (to read the committed canonical
`.txt`/`.asset` pair) and `DOCX_PARAGRAPHS` (one paragraph per line for the
freeform check). Missing inputs are skipped rather than failing.

Upstream sources of truth live in the *Into The Stars* Unity project:
`Assets/Editor/BatchDialogueGenerator.cs`,
`Assets/Scripts/Scriptable/DialogueScriptable.cs`,
`Assets/Scripts/Models/UiModels/DialogueLineUiModel.cs`, and
`Assets/Scripts/Types/GameEnums.cs`.

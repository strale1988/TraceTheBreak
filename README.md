# Translating legal content (Terms, Privacy Policy, footer)

Same idea as the main `languages/` folder, but for the three pieces of legal
copy: `copyright_footer`, `terms_of_service`, and `privacy_policy`. They're
kept together in one file per language since they're normally translated as
a set.

## Steps

1. Copy `en.json` to `<code>.json`, using the same 2-letter code as that
   language's file in the main `languages/` folder (e.g. `de.json` for
   German).
2. Translate the three string values. `terms_of_service` and
   `privacy_policy` use `\n` for line breaks within the text — keep those,
   the app renders them as actual line breaks.
3. Save the file here. Reload the app — that language now shows the
   translated Terms/Privacy Policy/footer automatically, no code change or
   rebuild needed.

## Notes

- English (`en.json`) is the fallback: if a language file is missing here,
  or missing one of the three keys, the app falls back to the English
  version of that piece of content, then to a small hardcoded fallback
  string if even English somehow fails to load.
- This is separate from the UI-string translation files in the parent
  `languages/` folder — a language can have one without the other (e.g. its
  UI is translated but its Terms of Service isn't yet, or vice versa).
- Heads up: the current English/Serbian `terms_of_service` has an
  incomplete sentence in section 18 ("Governing Law") — it names no actual
  jurisdiction ("...we apply the laws of to interpret..."). Worth fixing in
  `en.json`/`sr.json` before those get used as the source for further
  translations, so the gap isn't copied into every new language.

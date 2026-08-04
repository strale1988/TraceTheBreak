# Adding a new language

Each file in this folder is one language. The app finds them automatically —
you don't need to touch `app.js`, `index.html`, or anything else.

## Steps

1. Copy `en.json` to `<code>.json`, where `<code>` is a 2-letter language
   code from the `EUROPEAN_LANGUAGES` list near the top of the i18n section
   in `app.js` (e.g. `de.json` for German, `fr.json` for French). If the
   language you want isn't in that list yet, add one line there too — that
   list only controls what shows up (enabled or disabled) in the dropdown,
   it doesn't need a matching file to exist yet.
2. Translate every value inside `"strings"`. Keep the keys exactly as they
   are — they're what the app code looks up. Leave any `{placeholder}`
   tokens (like `{acc}`, `{url}`, `{title}`) untouched; the app fills those
   in at runtime.
3. Set `"name"` (English name of the language, used internally) and
   `"nativeName"` (what should show in the dropdown, e.g. `"Deutsch"`).
4. Save the file here. Reload the app — the dropdown option for that
   language stops being greyed out and the file loads automatically the
   moment it's selected (or auto-detected by location).

## Notes

- English (`en.json`) is the fallback: any language file that's missing a
  key, or a key that hasn't been translated yet, will silently show the
  English string instead of a blank or broken key.
- This only covers UI text. Some content comes from the database instead
  (report categories, badge names, municipality names, etc.) and today only
  has English/Serbian columns — translating that is a separate, backend
  change and isn't affected by adding a file here.
- No build step is required for translations — these are plain JSON files
  fetched directly by the browser, unlike `app.js`/`style.css` which do need
  `npm run build` after an edit.

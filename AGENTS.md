# Instructions for working on Literig

## Project

This is the Literig repository:

- GitHub: `https://github.com/ivoenglund/literig`
- Main application: `LifeCoach/`
- Production frontend: `https://literig.com/LifeCoach/`
- Production API: `https://lifecoach-api-production-361a.up.railway.app`
- API Railway service: `lifecoach-api`
- Database Railway service: `lifecoach`

The owner is Ivo. Communicate in Swedish unless Ivo asks for another language. Be patient, concrete and beginner-friendly.

## Critical safety rules

1. Make the smallest change that solves the requested problem.
2. Do not modify the repository root `index.html`.
3. Do not modify `CNAME`.
4. Do not expose, print, commit or copy secrets. This includes Railway variables, database URLs, `FAL_KEY`, OpenRouter keys and tokens.
5. Never put API keys in frontend code.
6. Do not change the database schema or data unless Ivo explicitly requests it or the requested feature requires a clearly documented migration.
7. Do not delete, reset, overwrite or roll back user data.
8. Do not blindly roll back deployments. Inspect deployment history and verify the target generation first.
9. Do not add unrelated buttons, columns, layout changes or features.
10. Do not claim that something works until it has been actually tested.

## Git workflow

Before editing:

```bash
git status
git pull origin main
```

For a non-trivial change, use a branch:

```bash
git checkout -b fix/short-description
```

Before committing:

```bash
git diff --check
node --check LifeCoach/server.js
```

For frontend JavaScript, extract the inline script from `LifeCoach/index.html` and run `node --check` on the extracted file.

Show the user the important diff and explain what was tested. Do not merge a pull request or push to `main` without explicit approval unless Ivo has clearly asked for deployment.

## Life Coach UI rules

- Recipe picker stays in the left column.
- Daily entries stay in the middle column.
- Nutrition stays in the right column.
- iPad users must be able to add recipes with a button; drag-and-drop may remain but must not be the only method.
- Keep the dark theme as the default when no previous choice exists.
- Theme preference uses `localStorage['literig_theme']`.
- Status, error, loading and confirmation messages must be centered modal dialogs. Do not use browser `alert()` or ugly edge notifications.
- Loading dialogs must clearly say what is happening.
- Do not move panels or change chat height without an explicit request.
- In light mode, edit fields have white backgrounds and dark text.
- Missing nutrition data displays `—`, never invented zeros.
- The nutrition table heading must be exactly `Dagsbehov %` and must not gain a separate reference/status column.

## Recipe import rules

- A URL is a recipe-import request.
- Recipe import must show a review step before saving.
- The user must be able to review and edit the name, image, ingredients, quantities, units and instructions.
- One ingredient per row.
- Original recipe amounts and units should be preserved for display, for example `2 äpplen`, `2 dl socker` or `1 msk olja`.
- Safe internal gram conversions may be stored separately for nutrition calculations.
- Never invent a gram conversion. If conversion is uncertain, preserve the original unit and mark the internal gram value as unavailable.
- AI output is a proposal. The review dialog must tell the user to check all ingredients, amounts, units, image and instructions.
- Successful saving should not show an unnecessary success alert. Show a centered error dialog only when saving fails.
- AI keys stay on the backend and must never be exposed to the browser.

## Recipe display and printing

- Recipe display should be clean and readable, with a modest image size.
- Ingredients remain on separate lines.
- Printing uses a separate clean A4 layout, not the editing form.
- Print body text is 11 pt maximum.
- Print main title is 15 pt maximum.
- Print subheadings are no larger than 12 pt.
- Use simple line spacing, normal margins, no separator lines between ingredients, left-aligned content and a separate image column on the right when an image exists.
- Print ingredient quantities in their original display units when available; do not force the printed recipe to show grams if the original recipe used another unit.

## Nutrition and data integrity

- Nutrition values must come from registered source data and explicit quantities.
- Fineli is preferred where applicable.
- Missing values must not be replaced by guesses.
- Historical daily instances must be protected from later changes to standard recipes or food data.
- Keep medicine/supplement documentation separate from recipes and nutrition tables.

## Verification before saying done

For a frontend change:

1. Run syntax checks.
2. Run the relevant local browser/runtime check.
3. Test both desktop and a narrow/touch-like viewport when the change affects layout.
4. Check browser console errors.
5. If deployed, verify the production URL and relevant API health endpoint.

For a backend/database change:

1. Run `node --check LifeCoach/server.js`.
2. Review the migration for repeatability and safety.
3. Deploy only after review.
4. Verify `https://lifecoach-api-production-361a.up.railway.app/api/health`.
5. Test the changed API route with a non-destructive request where possible.

If a deploy fails, report the real error. Never invent successful output.

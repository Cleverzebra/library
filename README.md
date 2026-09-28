# Cleverzebra Library

A home screen for the GitHub Pages sites on the Cleverzebra account. It finds newly published sites by itself, opens as an app from the Mac Dock or the iPhone Home Screen, and keeps working offline once it has loaded. It is plain HTML, CSS, and JavaScript in `docs/`, with no build step, no accounts, no analytics, and no token in the page.

## Address and repository name

This repository is `Cleverzebra/library`, so GitHub Pages will publish it at `https://cleverzebra.github.io/library/`. The plan named the repository `cleverzebra-library` (`https://cleverzebra.github.io/cleverzebra-library/`). To use that address, rename the repository before turning on Pages: **Settings > General > Repository name**, enter `cleverzebra-library`, then **Rename**.

Rename before adding the library to any device. GitHub redirects everything after a rename except Pages addresses ([GitHub Docs](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)), so an installed copy would keep pointing at the old address. The site uses relative paths throughout and recognizes itself by repository id (1388362103), so it works, and never lists itself, under either name.

## Setting up GitHub Pages

1. Rename the repository if you want the `cleverzebra-library` address (above).
2. **Settings > Pages > Build and deployment > Source: GitHub Actions.**
3. Merge the pull request into `main`. The **Publish library** workflow runs, tests the library, and publishes it in about a minute. To publish again without a change, open **Actions > Publish library > Run workflow**.

Without Actions: choose **Source: Deploy from a branch**, branch `main`, folder `/docs`, then **Save**. Everything below still works except the server-side fallback check.

## How new sites are found

**When.** The library checks for new sites when it opens and the last successful check is more than an hour old, when it comes back to the foreground or back online (same one-hour rule), once an hour while it stays open, and whenever you choose **Check for new sites**.

**How.** It lists every public repository on the Cleverzebra account through GitHub's public API, following every page of results, and keeps the repositories with GitHub Pages turned on. It then requests each site's address to confirm that it is published. It uses the address from the repository's Pages settings when GitHub provides it (custom domains included) and follows redirects to the final address. A repository's homepage field counts only as a candidate address that must also answer. Repositories without Pages, Pages sites that answer "not found", private repositories, and the library itself are left out. A site whose address can't be reached during a check is left out for now and checked again next time.

Nothing is lost when a check fails. If GitHub is unreachable, asks the library to wait, or sends an answer it can't read, the saved list stays exactly as it was. A check that stops partway can add sites it confirmed but never removes any. A site is removed only after two complete checks in a row confirm it is gone.

The status line tells the two cases apart. "Last checked for new sites today at 9:41 AM. No new sites." means the check worked and found nothing new. "Couldn't check for new sites" means it could not finish; the line gives the reason in parentheses and says which saved list is showing. The time is when the library last looked for sites; it is not a review of what the sites say.

A **Recently added** badge marks a site the library first found within the last 14 days. The 13 starting sites never carry it.

Without a token, GitHub allows 60 API requests per hour per network address ([GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). A check uses one request, plus one per brand-new site to read its Pages settings, so the limit only matters if something else on the same network uses GitHub heavily. When GitHub asks the library to wait, the status line says until when, and the library does not ask again before then. GitHub's API accepts requests from any web page ([GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests)), and the address checks go to `cleverzebra.github.io`, the library's own address, so the browser allows them.

## The fallback workflow

`.github/workflows/publish.yml` runs on every change to `main`, every six hours, and on demand. It runs the same check on GitHub's servers with the workflow's built-in token and publishes the result with the site as `data/catalog.json`. A device that can't reach GitHub's API (for example on a network that has used up the hourly limit) starts from that list. A scheduled run publishes only when the list changed. If Pages deploys from a branch, the workflow notices and publishes nothing.

Permissions are the minimum each job needs: the build job has `contents: read` and `pages: read`; the deploy job has `pages: write` and `id-token: write`. The token is sent only to `api.github.com` (a test checks this) and never reaches the page. The workflow publishes the site itself instead of committing the list, so it needs no write access to the repository.

Scheduling limits ([GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)): GitHub can start scheduled runs late when it is busy, especially near the top of the hour, and can drop some; the schedule uses minute 17 to lower that chance. In a public repository GitHub turns a schedule off after 60 days without activity in the repository. Turn it back on from the Actions tab. The page's own checks keep working meanwhile.

## Changing how a site appears

New sites need no entry anywhere. To change a title, description, category, or order, or to hide a site, edit `docs/data/overrides.json`. Keys are repository names:

```json
"garden-planner": { "title": "Garden Planner", "category": "Gardens", "order": 3, "description": "Plan the beds by week.", "tags": ["vegetables"] },
"old-experiment": { "exclude": true }
```

Categories appear in the order of the `categories` list; a site without one goes under Other. A new site can also be filed without editing anything by giving its repository a GitHub topic that matches a category name, such as `local-guides` or `monhegan`. Changes to this file show up the next time the library opens.

## Adding it to the Mac Dock and iPhone Home Screen

**Mac (Safari, macOS Sonoma or later):** open the library, choose **File > Add to Dock** (or **Share > Add to Dock**), keep or change the name, and click **Add** ([Apple Support](https://support.apple.com/en-us/104996)).

**iPhone (Safari):** open the library, tap **Share** (on newer iPhones, tap **•••** first), scroll to **Add to Home Screen**, turn on **Open as Web App** if shown, and tap **Add** ([Apple Support](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)).

These instructions are also under **More** in the library.

**Favorites stay on the device where you set them.** The Dock and Home Screen versions keep their own storage, separate from Safari, and nothing syncs between devices. To copy favorites, use **More > Export favorites** on one and **Import favorites** on the other. In an ordinary Safari tab, Safari can clear a site's saved data after seven days of Safari use without a visit; the Dock and Home Screen versions are exempt ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).

## Offline use, updates, and the other Cleverzebra sites

After the first visit, the library opens without a connection and shows the last saved list. The sites it links to may still need a connection.

All Cleverzebra sites share one web address (`cleverzebra.github.io`), so they share the browser's storage. Everything the library stores is labeled as its own: storage keys start with `cleverzebra-library:v1:`, caches with `cleverzebra-library-`, and its database is `cleverzebra-library-offline`. Its service worker controls only the library's folder, and it never deletes or reads anything that belongs to another site.

**Found during review, not changed:** the Sofia & Bandit's Somerville site's service worker (`sofia-somerville-guide/sw.js`) deletes every cache on the shared address except its own whenever it updates. The library survives this because it keeps a backup copy of its files in its own database (tested), but any other site that adds offline support would lose its cache. Limiting that cleanup to the site's own caches is a one-line change in that repository.

**Updates.** When a new version is published, an open library shows "A new version of the library is ready" with a **Reload** button; otherwise the new version starts the next time the app is opened after all its windows are closed. After changing any file in `docs/` other than `docs/data/`, run `npm run stamp` so installed copies see the change; the tests fail if this step is missed.

## Testing

- `npm test` runs the unit tests with Node 20 or later; no install needed.
- `npm install`, then `npm run test:e2e`, runs the browser tests in Chromium at desktop (1280 × 900) and iPhone 13 sizes.
- GitHub is replaced by a mock in every test. No test touches the real account or creates repositories.

**Tested:** desktop and phone layouts with no sideways scrolling and 44-pixel touch targets; every card's link, title, category, and description; search across titles, descriptions, and tags, including the no-results message; category filters and reset; keyboard use (skip link, `/` to search, Escape, arrow keys through the filters); favorites saved, reloaded, synced between two open windows, and kept across refreshes and the switch from starter names to permanent repository ids; export and import, including rejected files and favorites for sites not found yet; a newly published repository appearing on its own with Recently added in Other; unpublished repositories and the library itself left out; results on a second page of repositories; a rate limit, a server error, an unreadable answer, and an empty answer each leaving the saved list untouched; removal only after two confirming checks; offline loading from the saved copy; recovery after another site deletes every cache; another site's cache and storage left untouched; the update prompt; the library working at `/library/` as well; the fallback workflow's publish decisions and its token handling; and an automated accessibility scan (axe, WCAG 2.2 AA) with no findings.

**Still to test on a Mac and an iPhone:** Safari's rendering of the headings font and the illustration; Add to Dock and Add to Home Screen, and opening the installed apps offline; the update prompt inside the installed apps; and exporting favorites on the iPhone (share sheet) and importing from Files. The workflow's first real run, on September 27, 2026, published the site, and its check found all 13 sites.

## Files

- `docs/` is the published site: `index.html`, `css/`, `js/`, `icons/` (app icons and the bookshelf illustration), `fonts/` (Fraunces, the headings font, under the SIL Open Font License in `fonts/OFL.txt`), `manifest.webmanifest`, `sw.js`, and `data/` (`catalog.json`, the starter list; `overrides.json`, titles and categories).
- `scripts/` holds `build-catalog.mjs` (used by the workflow), `stamp.mjs` (sets the offline version), and `render-icons.mjs` (redraws the PNG icons from `docs/icons/icon.svg`).
- `tests/` holds the unit tests, the browser tests, and the mock GitHub.

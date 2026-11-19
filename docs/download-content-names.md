# Naming downloads by their content

Settings › General › Downloads › **Name downloads by what's in them** (`nameDownloadsByContent`, off by default).
When it's on, each download that finishes while Ardia watches it is read on this Mac and renamed
`YYYY-MM-DD_category_short-title.ext`, like `2026-10-31_invoice_acme-cloud-hosting.pdf`.

- **On-device only.** Apple's Foundation Models (`SystemLanguageModel.default`) on macOS 26 and later. The row only
  shows where the framework exists (`downloads.namerStatus` isn't `"unsupported"`, `PLATFORM_FEATURES.namesDownloadsOnDevice`,
  Mac only). When Apple Intelligence is off, not downloaded or not supported on the Mac, downloads are left as they
  are, with nothing shown. `FoundationModels` is weak-linked, so the app still launches on macOS 14 and 15.
- **What is read** (`packages/ardiacore/ios/DownloadNamer.swift`): the first 3 pages of a PDF (PDFKit), text in an
  image (Vision OCR), RTF, Word and OpenDocument text, and the first 64 KB of plain text, source, JSON, CSV and HTML.
  At most 6,000 characters go to the model; anything else (archives, disk images, audio, video) keeps its name. The
  model answers a fixed shape (`@Generable`): a category from a fixed list, a short title and an optional date.
- **The name** (`state/downloads/contentName.ts`): the date the content states when it's a real one, else the day the
  download finished; the category from `CONTENT_NAME_CATEGORIES`, else `other`; the title as an ASCII slug of at most
  48 characters, without the category word; the original extension, lowercased (`.tar.gz` and friends kept whole).
- **Through Chromium's download item.** The rename is `downloads.rename` → `ac_downloads_rename` →
  `DownloadItem::Rename`, so Chromium's own record, history and Show in Finder follow the new name. A taken name gets
  `-2`, `-3`, `-4`. An engine without `ac_downloads_rename` turns the feature off for the launch without a word.
- **Skipped:** history the engine replays at launch, private and off-the-record downloads, dangerous ones, WebKit
  downloads, and any download a `download.deciding` hook moved (the move happens outside Chromium, so the item no
  longer points at the file).
- **Revert.** `download-names.json` (version 1) keeps each renamed download's original and suggested names by
  download id (the last 500). The row's arrow (on hover in the panel, beside Show in Finder on the Downloads page) and
  the context menu switch between the two, through the engine again. A name changed elsewhere (Finder) offers no switch.
- **Motion.** While the model reads, the name shimmers (two soft highlight bands sweep across it, 1.3 s, then a 0.35 s
  rest) and the status line says "Finding a name…". The new name arrives in a 380 ms morph: the old one lifts 5 pt and
  fades, the new one rises into place. Reduce Motion turns the sweep into a gentle pulse and the morph into a crossfade.
- **One at a time.** Model calls queue, so several downloads finishing together don't slow each other (a warm call
  takes 1.5 to 3 s on an M-series Mac, the first after launch about 12 s).
- **Counts** (`usage_counts`, `state/telemetry/downloadsPanelCounts.ts`): `download_content_names`,
  `download_content_names_unreadable`, `download_content_names_failed`, `download_content_names_unavailable`,
  `download_content_name_reverts`, `download_content_name_restores`. Watch reverts against names: a high share means
  the names aren't good enough. No names, paths or content are sent.

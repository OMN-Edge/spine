# The retired PDF sidecar

Until October 2026 the server read a PDF's text layer through a second process: a small Python service wrapping [Unstructured](https://github.com/Unstructured-IO/unstructured), called over HTTP. It is replaced by `core/src/ingestion/pdf-text.ts`, which does the same job in-process with [PDF.js](https://mozilla.github.io/pdf.js/) and needs no Python. The service itself is kept in [sidecar/](sidecar/) as a reference and is neither built nor started by `install.sh` or `compose.yaml`. This page records what it offered, so that a choice to go back, or to use more of Unstructured, is an informed one.

## Why it was replaced

- **One process, no Python.** The sidecar needed Python 3.11 to 3.13, a virtualenv, about thirty pinned packages (OpenCV, NumPy, SciPy, pandas, ONNX, spaCy) and a systemd unit or a second container. It was the heaviest part of an install, for a job that uses none of that.
- **It crashed on Apple M4 under Docker or Colima.** The VM reports the SME instruction set and OpenCV, OpenSSL, BLIS and NumPy die with "illegal instruction". PDF.js is JavaScript.
- **It used almost nothing of Unstructured.** The `fast` strategy reads the text layer and nothing else; no OCR, no layout model.
- **The browser can run it.** The encryption redesign ([crypto-design.md](crypto-design.md)) moves reading onto the device, where a Python service cannot go. PDF.js runs in both places.
- **Measured.** On a real one-page medical report and on synthetic files, PDF.js returned the same words as the sidecar (206 of 206, none extra, none missing). Boxes end about 2 pt higher at the bottom without the allowance for descenders that `pdf-text.ts` adds back.

## What the sidecar did

`POST /parse {file_path}` read the file from disk (the data volume, mounted read-only) with `partition_pdf(filename, strategy="fast")` and returned, per page that had any text:

```json
{ "page_number": 1, "image_width": 595.28, "image_height": 841.89, "extraction_source": "native_text",
  "elements": [ { "type": "NarrativeText", "text": "…", "page_number": 1, "bbox": {"x0": 0, "y0": 0, "x1": 0, "y1": 0}, "source": "native_text" } ] }
```

- **Boxes** were in PDF points from the top-left corner, taken from the four corner points Unstructured reports; `image_width`/`image_height` were the coordinate system's size (the page size), so the server scaled them to the page image.
- **A page with nothing on it** was left out. A scan has no text layer, so it came back empty, which is how `hybrid` and `ocr` found the pages to send to Tesseract or a model.
- **Elements were paragraph-level**, roughly two lines each on the report we tried. `pdf-text.ts` groups PDF.js's text runs into lines and lines into paragraphs to match, so grounding still finds a value inside one box.
- `GET /health` for the service manager.

## What Unstructured offers that we never used

Nothing below was read by the application; it is here because it is what would be lost, or could be gained, by a different engine.

| Offered | What it is | Where it stands |
| --- | --- | --- |
| **Element categories** | `Title`, `NarrativeText`, `ListItem`, `Table`, `Header`, `Footer`, `PageNumber`, `Address`, `EmailAddress`, `UncategorizedText`, `Image`, `FigureCaption`, `Formula`. The real report came back as 13 titles, 4 narrative texts, 4 footers, 2 uncategorised, 1 header | The server stored `type` but never used it. `pdf-text.ts` labels everything `NarrativeText`. |
| **Metadata** | `page_number`, `coordinates` (points, with the system size), `filename`, `filetype`, `languages` (detected), `parent_id` (a title and what sits under it), `text_as_html` and `table` structure for `Table` in the layout strategies, `link_urls`/`link_texts`, `emphasized_text_contents`, `detection_class_prob` | Only page number and coordinates were read. |
| **`hi_res` strategy** | A layout-detection model (YOLOX or similar) and table-structure recognition, with OCR on image regions | Needs torch and the detection model, about 1.7 GB; never installed (`unstructured_inference` was installed with `--no-deps` for the `fast` path). |
| **`ocr_only` strategy** | Tesseract over every page | Local OCR is run page by page by `parser/ocr.ts` instead, so a text page is never OCR'd. |
| **Chunking** | `chunk_by_title`, `chunk_by_character`, by-similarity | Not used. Documents are chunked by `SPINE_LLM_CONTEXT_CHARS`. |
| **Other formats** | DOCX, HTML, email, images, XLSX, PPTX and more through other `partition_*` functions | Not used. DOCX, TXT and HEIC are converted on arrival by `ingestion/convert.ts`. |
| **Table cells** | `Table` elements with rows and columns | Only in `hi_res`. Lab results are read from text by the model into `measurements`. |

## What we gave up

- **Categories and `parent_id`.** If a later feature wants "this is a title" or "these lines belong under that heading", PDF.js gives font size and name per text run (`textContent.styles`, the transform's scale), so a heading heuristic is possible, but it is ours to write.
- **Table detection.** Neither engine's `fast` path finds tables. PDF.js keeps cells as separate runs when they are far apart, and `pdf-text.ts` keeps them as separate elements.
- **Reading order in columns.** Unstructured's `fast` path used pdfminer's layout analysis. `pdf-text.ts` orders by position and keeps a paragraph to its own column by overlap, which is simpler and has been tried on one real report and a few synthetic files, not on multi-column articles.

## Going back

`sidecar/` has the service, its `requirements.txt` and its `Dockerfile`. To use it again, restore `ingestion-client.ts` from git history (it is in the commit before the one that added `pdf-text.ts`), point `parser/index.ts`'s `sidecar` dependency at it, and add the container or unit back from the same commit. There is no switch for it, because a switch would keep both paths maintained.

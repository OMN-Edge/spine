"""
Spine ingestion sidecar — wraps Unstructured to extract text + bboxes from PDFs.
Called by the Node.js backend; never exposed outside the Docker network.
"""
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from unstructured.partition.pdf import partition_pdf

app = FastAPI()


class ParseRequest(BaseModel):
    file_path: str


@app.post("/parse")
def parse(req: ParseRequest):
    p = Path(req.file_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {req.file_path}")

    try:
        # "fast" reads only the text already inside the PDF. It never runs OCR and never
        # loads a layout model, so it is quick and light, and a page with no text layer
        # simply contributes no elements.
        #
        # It is explicit on purpose. "auto" is one decision for the whole file, not per
        # page (despite its docstring): any text anywhere picks "fast", none picks
        # "ocr_only" — a whole-file OCR pass. Scanned and handwritten pages are not this
        # service's job: the Node server finds them (a page with no elements here) and
        # reads them with local Tesseract or a vision model.
        elements = partition_pdf(filename=str(p), strategy="fast")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Group elements by page number. Page breaks and empty elements carry no text, so
    # they are dropped: a page with nothing on it must not look like it has content.
    pages: dict[int, dict] = {}
    for el in elements:
        if not (el.text or "").strip():
            continue

        meta = el.metadata
        page_num = meta.page_number or 1

        if page_num not in pages:
            pages[page_num] = {
                "page_number": page_num,
                "elements": [],
                # The size of the coordinate system the boxes are in (PDF points for
                # native text). The Node side scales the boxes into the page image.
                "image_width": meta.coordinates.system.width if meta.coordinates else 0,
                "image_height": meta.coordinates.system.height if meta.coordinates else 0,
            }

        bbox = None
        if meta.coordinates and meta.coordinates.points:
            pts = meta.coordinates.points
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            bbox = {"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)}

        pages[page_num]["elements"].append({
            "type": el.category,
            "text": el.text,
            "page_number": page_num,
            "bbox": bbox,
            "source": "native_text",
        })

    return {
        "pages": [
            {
                "page_number": page["page_number"],
                "elements": page["elements"],
                "extraction_source": "native_text",
                "image_width": page["image_width"],
                "image_height": page["image_height"],
            }
            for _, page in sorted(pages.items())
        ]
    }


@app.get("/health")
def health():
    return {"ok": True}

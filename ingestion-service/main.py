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
        # Unstructured's strategy auto-detects digital vs scanned per page.
        # "auto" tries fast (native text) first, falls back to hi_res (OCR) when needed.
        elements = partition_pdf(
            filename=str(p),
            strategy="auto",
            include_page_breaks=True,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Group elements by page number
    pages: dict[int, dict] = {}
    for el in elements:
        meta = el.metadata
        page_num = meta.page_number or 1

        if page_num not in pages:
            pages[page_num] = {
                "page_number": page_num,
                "elements": [],
                # image dimensions from Unstructured metadata (set when available)
                "image_width": meta.coordinates.system.width if meta.coordinates else 0,
                "image_height": meta.coordinates.system.height if meta.coordinates else 0,
                "has_ocr": False,
            }

        page = pages[page_num]

        bbox = None
        if meta.coordinates and meta.coordinates.points:
            pts = meta.coordinates.points
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            bbox = {
                "x0": min(xs),
                "y0": min(ys),
                "x1": max(xs),
                "y1": max(ys),
            }

        source = "native_text"
        if getattr(meta, "detection_origin", None) == "ocr":
            source = "ocr"
            page["has_ocr"] = True

        page["elements"].append({
            "type": el.category,
            "text": el.text,
            "page_number": page_num,
            "bbox": bbox,
            "source": source,
        })

    result_pages = []
    for page_num in sorted(pages.keys()):
        page = pages[page_num]
        has_native = any(e["source"] == "native_text" for e in page["elements"])
        has_ocr = page["has_ocr"]
        extraction_source = (
            "mixed" if has_native and has_ocr
            else "ocr" if has_ocr
            else "native_text"
        )
        result_pages.append({
            "page_number": page["page_number"],
            "elements": page["elements"],
            "extraction_source": extraction_source,
            "image_width": page["image_width"],
            "image_height": page["image_height"],
        })

    return {"pages": result_pages}


@app.get("/health")
def health():
    return {"ok": True}

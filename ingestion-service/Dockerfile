# The PDF text-layer sidecar (Unstructured, strategy "fast"). Reads files from the data volume, mounted read-only.
FROM python:3.12-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils libglib2.0-0 libmagic1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 # --no-deps: its dependencies include torch and transformers (about 1 GB), and strategy="fast" uses neither (see requirements.txt)
 && pip install --no-cache-dir --no-deps unstructured_inference==1.6.13
# Unstructured downloads this spaCy model on first use and drops a page's text if it cannot; the filesystem is read-only, so fetch it now.
RUN python -m spacy download en_core_web_sm
# OpenCV 5.0's arm64 wheel dies with SIGILL on CPUs that report SME (Apple M4 under Docker/Colima). The sidecar only needs it to import.
RUN pip install --no-cache-dir opencv-python-headless==4.11.0.86
COPY main.py .
RUN useradd --system --no-create-home spine
USER spine
# Same cause: OpenSSL's ARM feature probe (used by cryptography, for encrypted PDFs) also dies on SME. Costs only crypto speed.
# BLIS_ARCH: spaCy's math library probes the CPU the same way. The sidecar does little arithmetic, so the generic kernels cost nothing noticeable.
ENV HOME=/tmp OPENSSL_armcap=0 BLIS_ARCH=generic
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

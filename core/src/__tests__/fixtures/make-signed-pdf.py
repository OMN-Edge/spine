import subprocess, sys, re

def _node(b, i):
    """(tag, start of body, end) of the DER value at i; definite lengths only, which `openssl cms -outform DER` writes."""
    tag = b[i]; n = b[i + 1]; i += 2
    if n & 0x80:
        k = n & 0x7f; n = int.from_bytes(b[i:i + k], "big"); i += k
    return tag, i, i + n
def _enc(tag, body):
    n = len(body)
    head = bytes([n]) if n < 128 else (bytes([0x81, n]) if n < 256 else bytes([0x82, n >> 8, n & 255]))
    return bytes([tag]) + head + body
def add_crls(cms, crls):
    """The CMS signed-data with `crls` (DER lists) added as its [1] revocation lists, after the certificates. They are not signed, so the signature still holds."""
    if not crls: return cms
    _, o, end = _node(cms, 0)
    # ContentInfo: SEQUENCE { OID, [0] EXPLICIT { SignedData } }
    oid_tag, oid_start, oid_end = _node(cms, o)
    wrap_tag, wrap_start, wrap_end = _node(cms, oid_end)
    sd_tag, sd_start, sd_end = _node(cms, wrap_start)
    parts = []; i = sd_start
    while i < sd_end:
        t, s0, e0 = _node(cms, i); parts.append((t, cms[i:e0])); i = e0
    out = []
    for t, raw in parts:
        out.append(raw)
        if t == 0xa0: out.append(_enc(0xa1, b"".join(crls)))   # right after the certificates
    assert any(t == 0xa0 for t, _ in parts), "the signature carries no certificates to put the lists after"
    signed_data = _enc(0x30, b"".join(out))
    return _enc(0x30, cms[o:oid_end] + _enc(0xa0, signed_data))

def make(out, cert, key, size=8192, certfile=None, crls=()):
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [5 0 R] >>", b"<< /Length 0 >>\nstream\n\nendstream"]
    sig = b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 0000000000 0000000000 0000000000] /M (D:20260301101500+02'00') /Contents <" + b"0"*size + b"> >>"
    annot = b"<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /T (Sig) /V 6 0 R /P 3 0 R >>"
    objs += [annot, sig]
    pdf = b"%PDF-1.7\n"; offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(pdf)); pdf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs)+1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs)+1, xref)
    c = pdf.index(b"/Contents <") + len(b"/Contents ")
    end = c + size + 2
    br = b"/ByteRange [0 %010d %010d %010d]" % (c, end, len(pdf)-end)
    i = pdf.index(b"/ByteRange"); j = pdf.index(b"]", i)+1
    pdf = pdf[:i] + br + pdf[j:]
    signed = pdf[:c] + pdf[end:]
    open("signed.bin","wb").write(signed)
    der = subprocess.run(["openssl","cms","-sign","-binary","-outform","DER","-signer",cert,"-inkey",key,"-md","sha256","-in","signed.bin"] + (["-certfile", certfile] if certfile else []),check=True,capture_output=True).stdout
    der = add_crls(der, list(crls))
    assert len(der)*2 <= size
    pdf = pdf[:c+1] + der.hex().encode().ljust(size, b"0") + pdf[c+1+size:]
    open(out,"wb").write(pdf)
make(sys.argv[1], sys.argv[2], sys.argv[3], certfile=sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != '-' else None, crls=[open(p, 'rb').read() for p in sys.argv[5:]])

import subprocess, sys, re
def make(out, cert, key, size=8192, certfile=None):
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
    assert len(der)*2 <= size
    pdf = pdf[:c+1] + der.hex().encode().ljust(size, b"0") + pdf[c+1+size:]
    open(out,"wb").write(pdf)
make(sys.argv[1], sys.argv[2], sys.argv[3], certfile=sys.argv[4] if len(sys.argv) > 4 else None)

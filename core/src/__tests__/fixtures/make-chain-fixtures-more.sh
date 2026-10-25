#!/bin/sh
# More invented certificates and PDFs signed with them, for signatures-cms.test.ts: a signer through an intermediate authority, the same
# with the intermediate left out of the file, a certificate issued by one that is not an authority, and chains whose certificates are
# signed with RSA. Run from this directory: ./make-chain-fixtures-more.sh. Needs OpenSSL 3.4+ and python3. Names and keys are made up.
# Separate from make-chain-fixtures.sh so that the files that script made do not change.
set -e
HERE=$(pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp make-signed-pdf.py "$work/make.py"
cd "$work"

ec() { openssl ecparam -name prime256v1 -genkey -noout -out "$1.key"; }
rsa() { openssl genrsa -out "$1.key" 2048 2>/dev/null; }
# name, keytype (ec|rsa), subject
authority() { "$2" "$1"; openssl req -new -x509 -key "$1.key" -subj "$3" -days 3650 -out "$1.pem" -sha256 \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"; }
# name, keytype, issuer, subject, basicConstraints  (an issued certificate; the authority flag is given, so a test can have one that is not)
issue() { "$2" "$1"; openssl req -new -key "$1.key" -subj "$4" -out "$1.csr"
  case "$5" in *CA:TRUE*) usage="critical,keyCertSign,cRLSign" ;; *) usage="critical,digitalSignature,nonRepudiation" ;; esac
  printf "basicConstraints=%s\nkeyUsage=%s\n" "$5" "$usage" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial -days 3650 -sha256 -extfile "$1.ext" -out "$1.pem" 2>/dev/null; }
sign() { python3 make.py "$HERE/$1" "$2.pem" "$2.key" "$3"; }

# Root -> intermediate authority -> signer, all ECDSA
authority root_i ec "/CN=Example Intermediate Test Root/O=Example Trust"
issue inter ec root_i "/CN=Example Intermediate Test CA/O=Example Trust" "critical,CA:TRUE"
issue dan ec inter "/GN=Dan/SN=Intermediar/CN=Dan Intermediar" "CA:FALSE"
cat inter.pem root_i.pem > with_inter.pem
sign signed-chain-intermediate.pdf dan with_inter.pem
sign signed-chain-missing-intermediate.pdf dan root_i.pem
openssl x509 -in root_i.pem -outform DER -out "$HERE/chain-root-intermediate.der"

# A certificate issued by one that is not an authority (basicConstraints CA:FALSE) must not lead to the root
issue notca ec root_i "/GN=Radu/SN=Neautoritate/CN=Radu Neautoritate" "CA:FALSE"
issue eva ec notca "/GN=Eva/SN=Fictiva/CN=Eva Fictiva" "CA:FALSE"
cat notca.pem root_i.pem > with_notca.pem
sign signed-chain-not-an-authority.pdf eva with_notca.pem

# RSA root -> RSA signer, and RSA root -> ECDSA signer
authority root_r rsa "/CN=Example RSA Test Root/O=Example Trust"
issue sara rsa root_r "/GN=Sara/SN=Exemplara/CN=Sara Exemplara" "CA:FALSE"
issue paul ec root_r "/GN=Paul/SN=Mixt/CN=Paul Mixt" "CA:FALSE"
sign signed-chain-rsa.pdf sara root_r.pem
sign signed-chain-rsa-root-ec-signer.pdf paul root_r.pem
openssl x509 -in root_r.pem -outform DER -out "$HERE/chain-root-rsa.der"

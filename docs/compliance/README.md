# Compliance file

The records a controller keeps (GDPR Art. 5(2), 24, 30, 33, 35) for a Spine service, as first drafts written from what the software does. **They are drafts for a lawyer and the data protection adviser to review and for the controller to adopt; none of them is legal advice, and nothing here has been reviewed by one.** An operator who runs their own instance is the controller of it and writes their own.

| Item | File | Status |
| --- | --- | --- |
| Privacy notice (Art. 13), terms, written intended purpose (MDR, MDCG 2019-11) | `docs/legal/` (served by the app at `/privacy`, `/terms`, `/purpose`; `SPINE_LEGAL_DIR` replaces them) | Draft |
| Consent to the use of health data, separate from the terms (Art. 9(2)(a)) | recorded per account with the version shown (`legal.ts`) | Built |
| Record of processing activities (Art. 30) | [ropa.md](ropa.md) | Draft |
| Data protection impact assessment (Art. 35) | [dpia.md](dpia.md) | Draft |
| Breach procedure (Art. 33, 34) | [breach-procedure.md](breach-procedure.md) | Draft |
| Security measures (Art. 32) | [SECURITY.md](../../SECURITY.md) | Maintained with the code |
| Export and deletion in the app (Art. 15, 17, 20) | account page | Built |
| AI-generated content labelled (AI Act Art. 50) | document page, chat, shared page | Built |
| Processing agreements with hosting, model, email and payment providers (Art. 28) | with each provider | **Not done: contracts, not code** |
| Registration with a supervisory authority | none is needed in Romania since 25 May 2018 | n/a |

When any text in `docs/legal/` changes, raise `HEALTH_CONSENT_VERSION` or `TERMS_VERSION` in `server/src/legal.ts`: everyone is then asked to agree again at their next sign-in.
